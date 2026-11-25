/**
 * A member with no recorded admitter takes the network's schema from its FIRST member only (`Q-966`, review F3).
 *
 * A network stored before the admitter was recorded (`admittedVia`, Q-154) let ANY member answer the heal, and a member that had not healed
 * served its bare meta: the joiner then held a schema-less layer and stopped asking. The member the join pushed first (`members[0]`, the
 * inviter) is the source when nothing is recorded; no other member's answer is taken.
 *
 * A club of A, B and C (B knows A first, then C). B loses its layer, its mark and its admitter, and A's address on B is made unreachable.
 * C has not healed either (a decoy layer, no mark). Cycles later B holds no layer: C was not asked. With A's address back, B heals from A.
 *
 * Run: node --test testing/sync/a-member-with-no-recorded-admitter-takes-the-schema-from-its-first-member-only.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, syncUntil, patchContainerNetwork, reloadConfig, triggerSync, waitFor } from './helpers.js';
import { tokenOf, createClub, joinThrough, tearDown, layerOn, networkOn, metaOn, holdsSchema } from './_q966-club.mjs';

let club;
let idA;

before(async () => {
  club = await createClub('f3');
  await joinThrough(club, 'b');
  await joinThrough(club, 'c');
  await waitFor(async () => {
    for (const x of ['a', 'b', 'c']) await triggerSync(INSTANCES[x], tokenOf(x), club.networkId).catch(() => {});
    return (networkOn('b', club.networkId)?.members ?? []).length >= 2 && layerOn('c', club.networkId, club.space) !== undefined;
  }, 90_000, 2_000, () => `B's members: ${JSON.stringify((networkOn('b', club.networkId)?.members ?? []).map(m => m.label))}`);
  idA = networkOn('b', club.networkId).members[0].instanceId;
  const S = JSON.stringify(club.space);
  patchContainerNetwork('ythril-b', club.networkId, `
    delete n.admittedVia; delete n.schemaLayerSeeded;
    if (n.schemaLayers) delete n.schemaLayers[${S}];
    const s = cfg.spaces.find(x => x.id === ${S});
    if (s) { delete s.meta; delete s.ownMeta; }
    n.members[0].url = 'http://ythril-nowhere.invalid:3200';
  `);
  await reloadConfig(INSTANCES.b, tokenOf('b'));
  // C has not healed either: its layer is a decoy and its mark is gone, as a member of an older build holds it.
  patchContainerNetwork('ythril-c', club.networkId, `
    delete n.schemaLayerSeeded;
    n.schemaLayers[${S}] = { purpose: 'a decoy from a member that has not healed' };
  `);
  await reloadConfig(INSTANCES.c, tokenOf('c'));
});

after(() => tearDown([club]));

describe('a member with no recorded admitter', () => {
  it('starts with the first member being the inviter A (the premise)', () => {
    assert.equal(networkOn('b', club.networkId).members[0].instanceId, idA);
    assert.equal(networkOn('b', club.networkId).admittedVia, undefined);
  });

  it('takes nothing from another member while the first is unreachable', async () => {
    for (let i = 0; i < 2; i++) await triggerSync(INSTANCES.b, tokenOf('b'), club.networkId).catch(() => {});
    // An absence is read after a window long enough for a cycle that WOULD take it (it did, within seconds, when any member was asked).
    await waitFor(async () => layerOn('b', club.networkId, club.space) !== undefined, 12_000, 1_000).catch(() => {});
    assert.equal(layerOn('b', club.networkId, club.space), undefined, `B took a layer from a member that is not its first: ${JSON.stringify(layerOn('b', club.networkId, club.space))}`);
  });

  it('heals from the first member once it answers', async () => {
    patchContainerNetwork('ythril-b', club.networkId, `n.members[0].url = 'http://ythril-a:3200';`);
    await reloadConfig(INSTANCES.b, tokenOf('b'));
    let last;
    await syncUntil(INSTANCES.b, tokenOf('b'), club.networkId, async () => holdsSchema(last = await metaOn('b', club.space)),
      'B taking the schema from A', { onTimeout: () => `B's meta: ${JSON.stringify(last)}` });
  });
});
