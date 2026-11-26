/**
 * Sync: what a SPARQL Update landed reaches a peer as the ordinary rows and tombstones it is (bundle-272, Q-761; design-r2, vet-3 S6).
 *
 * An Update on A inserts an entity, converges another and deletes a third in one write group. After a sync, B holds exactly that: the new
 * entity, the converged value, and the deleted one gone behind its tombstone; a record the Update did not touch is unchanged.
 *
 * What it needs up: the sync stack (instances A and B), built from this checkout.
 *
 * Run: node --test testing/sync/a-sparql-update-reaches-a-peer-as-rows-and-tombstones.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, patch, del, reqJson, waitFor, getInstanceId, createTestSpace } from './helpers.js';
import { ownTokens } from '../_shared/own-token.mjs';

// An Update that deletes pays the heavy-call budget: it is sent with a token of this file's own, not the suite's shared one.
const own = ownTokens();

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs');
const RUN = Date.now();
const Y = 'https://w3id.org/ythril/ns#';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

let tokenA, tokenB, SPACE, removeSpace, networkId;
const ids = {};
const baseOf = (space) => `https://${space}.example.org/ld/${space}/`;

const onB = (kind, id) => reqJson(INSTANCES.b, tokenB, `/api/sync/${kind}/${id}?spaceId=${SPACE}`);

describe('a SPARQL Update reaches a peer as rows and tombstones', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    ({ id: SPACE, remove: removeSpace } = await createTestSpace('sparql-update-sync', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]));
    const on = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true, base: baseOf(SPACE) } } });
    assert.ok(on.status < 300, `RDF on: ${on.status} ${JSON.stringify(on.body)}`);
    for (const name of ['Keep', 'Change', 'Drop']) {
      const r = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/entities`, { name: `${name}-${RUN}`, type: 'concept' });
      assert.equal(r.status, 201, `entity ${name}: ${JSON.stringify(r.body)}`);
      ids[name] = r.body._id;
    }
    const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: `SPARQL Update Sync ${RUN}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
    assert.equal(net.status, 201, `network: ${JSON.stringify(net.body)}`);
    networkId = net.body.id;
    const ptB = await post(INSTANCES.b, tokenB, '/api/tokens', { name: `spu-sync-peer-${RUN}`, peerInstanceId: getInstanceId('ythril-a') });
    assert.equal(ptB.status, 201);
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'spu-sync-b', label: 'SPARQL Update Sync B', url: 'http://ythril-b:3200', token: ptB.body.plaintext, direction: 'both',
    });
    if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    else assert.equal(addB.status, 201, `add B: ${JSON.stringify(addB.body)}`);
    // B holds every record before the Update, so the tombstone is seen to remove a row B had.
    await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
    await waitFor(async () => (await onB('entities', ids.Drop)).status === 200, 40_000);
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await removeSpace?.();
  });

  it('B receives exactly the rows and the tombstone the Update landed', async () => {
    const at = (id) => `${baseOf(SPACE)}entity/${id}`;
    // A rename removes the old label as it inserts the new one: a name holds one value, and a second label is refused `several-values`.
    const text = `DELETE WHERE { <${at(ids.Drop)}> ?p ?o } ;
      DELETE DATA { <${at(ids.Change)}> <${LABEL}> "Change-${RUN}" } ;
      INSERT DATA { <${at(ids.Change)}> <${LABEL}> "Changed-${RUN}" .<${baseOf(SPACE)}entity/fresh> a <${Y}Entity>, <${baseOf(SPACE)}vocab/entity/concept> ; <${LABEL}> "Fresh-${RUN}" }`;
    const updater = await own.mint('spu-sync-update');
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/sparql/update`, {
      method: 'POST', headers: { Authorization: `Bearer ${updater}`, 'Content-Type': 'application/sparql-update' }, body: text,
    });
    const body = await r.json().catch(() => null);
    assert.equal(r.status, 200, `the Update on A: ${r.status} ${JSON.stringify(body)}`);
    const freshId = body?.ids?.entity?.[0];
    assert.ok(freshId, `the Update names no inserted id: ${JSON.stringify(body)}`);

    await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
    await waitFor(async () => (await onB('entities', freshId)).status === 200 && (await onB('entities', ids.Drop)).status === 404, 40_000)
      .catch(async () => {
        await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
        await waitFor(async () => (await onB('entities', freshId)).status === 200 && (await onB('entities', ids.Drop)).status === 404, 40_000);
      });
    assert.equal((await onB('entities', freshId)).body?.name, `Fresh-${RUN}`, 'the inserted row is not on B');
    assert.equal((await onB('entities', ids.Change)).body?.name, `Changed-${RUN}`, 'the converged row is not on B');
    assert.equal((await onB('entities', ids.Drop)).status, 404, 'the deleted row is still on B');
    assert.equal((await onB('entities', ids.Keep)).body?.name, `Keep-${RUN}`, 'a record the Update did not touch changed on B');
  });
});
