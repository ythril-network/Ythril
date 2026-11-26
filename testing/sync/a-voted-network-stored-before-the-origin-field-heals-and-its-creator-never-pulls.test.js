/**
 * A voted network stored before 5.2.0 (no `origin`) is read as joined, and a creator takes no layer from a member (`Q-966`, review F2, second review N3).
 *
 * `NetworkConfig.origin` is absent on a network stored before it existed, and everywhere else (`networkRole`, the type's own comment) an
 * absent one reads as JOINED. The heal read it as "not joined" and never ran for such a member. No other field tells a creator of that age
 * from a joiner (the create path and the join path write the same ones), so owning definitions never proves creation, and the heal's source is the
 * admitter's answer only. A network this build created has `origin: 'created'`: it never takes a layer, since its own definitions are where the
 * network's schema began, and it serves them as the network's, seeded (`networkSeeded: true` at the door).
 *
 * A club of A and B; the field is removed from B (which lost its layer, as an older build left it). B heals. A, which created the network, serves
 * its definitions as the network's and takes no layer from B, read after a window in which a cycle that WOULD take it has run.
 *
 * Run: node --test testing/sync/a-voted-network-stored-before-the-origin-field-heals-and-its-creator-never-pulls.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, syncUntil, patchContainerNetwork, reloadConfig, triggerSync, get } from './helpers.js';
import { elapse } from '../_shared/sleep.mjs';
import { tokenOf, createClub, joinThrough, tearDown, layerOn, metaOn, holdsSchema } from './_q966-club.mjs';

let club;

before(async () => {
  club = await createClub('f2');
  await joinThrough(club, 'b');
  const S = JSON.stringify(club.space);
  patchContainerNetwork('ythril-b', club.networkId, `
    delete n.origin; delete n.schemaLayerSeeded;
    if (n.schemaLayers) delete n.schemaLayers[${S}];
    const s = cfg.spaces.find(x => x.id === ${S});
    if (s) { delete s.meta; delete s.ownMeta; }
  `);
  await reloadConfig(INSTANCES.b, tokenOf('b'));
});

after(() => tearDown([club]));

describe('a network stored before the origin field', () => {
  it('a member without it heals: an absent origin is a joined network', async () => {
    let last;
    await syncUntil(INSTANCES.b, tokenOf('b'), club.networkId, async () => holdsSchema(last = await metaOn('b', club.space)),
      'B (no origin) taking the network\'s schema', { onTimeout: () => `B's meta: ${JSON.stringify(last)}` });
    assert.equal(layerOn('b', club.networkId, club.space)?.validationMode, 'strict');
  });

  it('its creator serves its own definitions as the network\'s, and says they are the whole schema', async () => {
    const r = await get(INSTANCES.a, tokenOf('a'), `/api/sync/meta?spaceId=${club.space}&networkId=${club.networkId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.networkSeeded, true, 'the creator did not say its schema is the whole one');
    assert.ok(holdsSchema(r.body.network), `the creator's network part lacks its definitions: ${JSON.stringify(r.body.network)}`);
  });

  it('its creator takes no layer from a member, however long the window', async () => {
    await triggerSync(INSTANCES.a, tokenOf('a'), club.networkId);
    await triggerSync(INSTANCES.b, tokenOf('b'), club.networkId);
    // An absence is read after a window long enough for a cycle that WOULD take it (B holds the whole layer and answers `networkSeeded: true`).
    await elapse(8_000, 'absence window: a cycle of the creator that asked B would have stored the layer within seconds');
    await syncUntil(INSTANCES.a, tokenOf('a'), club.networkId, async () => (await metaOn('a', club.space)).validationMode === 'strict', 'A still holding its own definitions');
    assert.equal(layerOn('a', club.networkId, club.space), undefined, 'the creator took its own schema back as a layer');
  });
});
