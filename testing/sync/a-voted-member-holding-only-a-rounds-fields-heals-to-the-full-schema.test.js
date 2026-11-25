/**
 * A member of a voted network whose layer holds only the fields of a passed round ends with the network's full schema (`Q-966`, review F1).
 *
 * The owner's live case: a member that joined before the join carried the schema, then received one passed `meta_change` round, holds a
 * layer of just that round's changed fields (the round is stored onto an empty layer). The heal asked only "is the layer absent", so it
 * never ran for it and the member went on without the types and the validation mode. The heal now runs while the layer is not SEEDED (the
 * join fetch, the heal, and the stores that carry the whole schema set the mark), and replaces the partial layer with the network's schema.
 *
 * A club of A and B; B's layer is then set as a passed round left it (one changed field, the mark removed), as is B's copy of the space.
 *
 * Run: node --test testing/sync/a-voted-member-holding-only-a-rounds-fields-heals-to-the-full-schema.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, syncUntil, patchContainerNetwork, reloadConfig } from './helpers.js';
import { tokenOf, createClub, joinThrough, tearDown, layerOn, metaOn, holdsSchema } from './_q966-club.mjs';

let club;

before(async () => {
  club = await createClub('f1');
  await joinThrough(club, 'b');
  patchContainerNetwork('ythril-b', club.networkId, `
    (n.schemaLayers ??= {})[${JSON.stringify(club.space)}] = { purpose: 'what a passed round changed' };
    delete n.schemaLayerSeeded;
    const s = cfg.spaces.find(x => x.id === ${JSON.stringify(club.space)});
    if (s) { s.meta = { purpose: 'what a passed round changed' }; delete s.ownMeta; }
  `);
  await reloadConfig(INSTANCES.b, tokenOf('b'));
});

after(() => tearDown([club]));

describe('a member whose layer holds only a passed round\'s fields', () => {
  it('starts with the partial layer (the premise)', () => {
    assert.equal(layerOn('b', club.networkId, club.space)?.validationMode, undefined);
    assert.equal(layerOn('b', club.networkId, club.space)?.purpose, 'what a passed round changed');
  });

  it('takes the network\'s full schema on its next cycle, as that network\'s layer', async () => {
    let last;
    await syncUntil(INSTANCES.b, tokenOf('b'), club.networkId, async () => holdsSchema(last = await metaOn('b', club.space)),
      'B healing from a partial layer to the full schema', { onTimeout: () => `B's meta: ${JSON.stringify(last)}; layer: ${JSON.stringify(layerOn('b', club.networkId, club.space))}` });
    assert.equal(layerOn('b', club.networkId, club.space)?.validationMode, 'strict', 'the schema must land in the network\'s layer');
  });
});
