/**
 * A voted network stored before 5.2.0 (no `origin`) is read as joined, and its creator is told apart without it (`Q-966`, review F2).
 *
 * `NetworkConfig.origin` is absent on a network stored before it existed, and everywhere else (`networkRole`, the type's own comment) an
 * absent one reads as JOINED. The heal read it as "not joined" and never ran for such a member. A network's creator that predates the field is
 * told apart by what it holds: no `origin`, no `admittedVia`, and own definitions for the space. It never takes a layer, since its own
 * definitions are where the network's schema began.
 *
 * A club of A and B; the field is removed from B (which lost its layer, as an older build left it) and from A. B heals; A holds no layer.
 *
 * Run: node --test testing/sync/a-voted-network-stored-before-the-origin-field-heals-and-its-creator-never-pulls.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, syncUntil, patchContainerNetwork, reloadConfig, triggerSync } from './helpers.js';
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
  patchContainerNetwork('ythril-a', club.networkId, 'delete n.origin; delete n.admittedVia;');
  await reloadConfig(INSTANCES.b, tokenOf('b'));
  await reloadConfig(INSTANCES.a, tokenOf('a'));
});

after(() => tearDown([club]));

describe('a network stored before the origin field', () => {
  it('a member without it heals: an absent origin is a joined network', async () => {
    let last;
    await syncUntil(INSTANCES.b, tokenOf('b'), club.networkId, async () => holdsSchema(last = await metaOn('b', club.space)),
      'B (no origin) taking the network\'s schema', { onTimeout: () => `B's meta: ${JSON.stringify(last)}` });
    assert.equal(layerOn('b', club.networkId, club.space)?.validationMode, 'strict');
  });

  it('its creator, with no origin and no admitter, takes no layer from a member', async () => {
    await triggerSync(INSTANCES.a, tokenOf('a'), club.networkId);
    await syncUntil(INSTANCES.a, tokenOf('a'), club.networkId, async () => (await metaOn('a', club.space)).validationMode === 'strict', 'A still holding its own definitions');
    await triggerSync(INSTANCES.b, tokenOf('b'), club.networkId);
    assert.equal(layerOn('a', club.networkId, club.space), undefined, 'the creator took its own schema back as a layer');
  });
});
