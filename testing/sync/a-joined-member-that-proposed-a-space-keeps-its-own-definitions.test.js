/**
 * A joined member that proposed a space keeps its own definitions as its own (`Q-966`, review F4).
 *
 * A member that adds one of its OWN spaces to a voted network stores no layer when the round passes: the definitions it proposed are its
 * own, and are the network's because it proposed them. The heal then found the layer "absent", took the admitter's copy of what it had
 * itself proposed, and kept it as the network's layer, which outranks its own definitions from then on. The proposer marks the space seeded
 * when the round passes, and never heals it.
 *
 * A closed network of A and B, B joined through A. B creates a space with a type and proposes it; A votes yes and the round passes. Once A
 * carries the space with its schema, B takes cycles: B holds no layer for it.
 *
 * Run: node --test testing/sync/a-joined-member-that-proposed-a-space-keeps-its-own-definitions.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, get, syncUntil, triggerSync, waitFor, delWithBody } from './helpers.js';
import { elapse } from '../_shared/sleep.mjs';
import { tokenOf, createClub, joinThrough, tearDown, layerOn, networkOn, metaOn } from './_q966-club.mjs';

let club;
const OWN = `q966-f4-own-${Date.now()}`;
const OWN_SCHEMA = { validationMode: 'strict', typeSchemas: { entity: { vessel: { propertySchemas: { draught: { type: 'number' } } } } } };

before(async () => {
  club = await createClub('f4', 'closed');
  await joinThrough(club, 'b');
  const tB = tokenOf('b');
  assert.equal((await post(INSTANCES.b, tB, '/api/spaces', { id: OWN, label: OWN })).status, 201);
  const m = await patch(INSTANCES.b, tB, `/api/spaces/${OWN}`, { meta: OWN_SCHEMA });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const add = await post(INSTANCES.b, tB, `/api/networks/${club.networkId}/spaces`, { spaceId: OWN });
  assert.equal(add.status, 202, JSON.stringify(add.body));
  const tA = tokenOf('a');
  let roundId;
  await waitFor(async () => {
    for (const x of ['a', 'b']) await triggerSync(INSTANCES[x], tokenOf(x), club.networkId).catch(() => {});
    const rounds = (await get(INSTANCES.a, tA, `/api/networks/${club.networkId}/votes`)).body?.rounds ?? [];
    roundId = rounds.find(r => r.type === 'space_addition' && r.spaceId === OWN)?.roundId;
    return !!roundId;
  }, 90_000, 2_000, () => 'A never learned the space_addition round');
  const yes = await post(INSTANCES.a, tA, `/api/networks/${club.networkId}/votes/${roundId}`, { vote: 'yes' });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
});

after(async () => {
  await tearDown([club]);
  for (const x of ['b', 'a']) await delWithBody(INSTANCES[x], tokenOf(x), `/api/spaces/${OWN}`, { confirm: true }).catch(() => {});
});

describe('a joined member that proposed a space', () => {
  it('A comes to carry the space with the schema B proposed', async () => {
    await waitFor(async () => {
      for (const x of ['a', 'b']) await triggerSync(INSTANCES[x], tokenOf(x), club.networkId).catch(() => {});
      return (networkOn('a', club.networkId)?.spaces ?? []).includes(OWN) && layerOn('a', club.networkId, OWN)?.validationMode === 'strict';
    }, 90_000, 2_000, () => `A's spaces: ${JSON.stringify(networkOn('a', club.networkId)?.spaces)}, layer: ${JSON.stringify(layerOn('a', club.networkId, OWN))}`);
  });

  it('holds no layer for it after its own cycles, and runs on its own definitions', async () => {
    for (let i = 0; i < 2; i++) await syncUntil(INSTANCES.b, tokenOf('b'), club.networkId, async () => true, 'a B cycle');
    // Give the cycle the trigger started the time to take a layer, were one to be taken.
    await waitFor(async () => (await metaOn('b', OWN)).validationMode === 'strict', 10_000, 500);
    await triggerSync(INSTANCES.b, tokenOf('b'), club.networkId).catch(() => {});
    await elapse(6_000, 'absence window: the cycle just triggered would have taken the admitter\'s copy within seconds (it did, before the proposer was marked)');
    assert.equal(layerOn('b', club.networkId, OWN), undefined, `B kept its admitter's copy as a layer in front of its own definitions: ${JSON.stringify(layerOn('b', club.networkId, OWN))}`);
    assert.equal((await metaOn('b', OWN)).typeSchemas?.entity?.vessel?.propertySchemas?.draught?.type, 'number');
  });
});
