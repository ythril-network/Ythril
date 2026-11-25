/**
 * What a joiner stores as the network's layer is the network's, whoever invited it (`Q-966`, review F6).
 *
 * A member that is not the network's creator served its OWN definitions plus its layer, so a joiner through it stored the member's own
 * types as the network's. The network's schema is what the network decided: the creator's definitions plus the passed rounds, which a
 * non-creator holds as its layer. A member now serves the network's part as exactly that (the creator its own definitions and layer, a
 * non-creator its layer for that network and nothing of its own), and a joiner reads that part.
 *
 * A club of A and B (B joined through A). B then defines a type of its own. C joins through B: C's layer is the layer a joiner through A
 * stores, with B's own type nowhere in it.
 *
 * Run: node --test testing/sync/a-joiner-stores-the-same-layer-whoever-invited-it.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, patchContainerNetwork, reloadConfig } from './helpers.js';
import { tokenOf, createClub, joinThrough, tearDown, layerOn, holdsSchema } from './_q966-club.mjs';

let club;

before(async () => {
  club = await createClub('f6');
  await joinThrough(club, 'b');
  // B's own definitions: a type the network never decided.
  patchContainerNetwork('ythril-b', club.networkId, `
    const s = cfg.spaces.find(x => x.id === ${JSON.stringify(club.space)});
    const own = { typeSchemas: { entity: { bOnly: { propertySchemas: { secret: { type: 'string' } } } } } };
    s.ownMeta = own;
    s.meta = { ...s.meta, typeSchemas: { entity: { ...(s.meta?.typeSchemas?.entity ?? {}), ...own.typeSchemas.entity } } };
  `);
  await reloadConfig(INSTANCES.b, tokenOf('b'));
  await joinThrough(club, 'c', 'b');
});

after(() => tearDown([club]));

describe('a joiner through a member that is not the creator', () => {
  it('stores the network\'s layer, the one a joiner through the creator stores', () => {
    const layer = layerOn('c', club.networkId, club.space);
    assert.ok(holdsSchema(layer), `C's layer lacks the network's schema: ${JSON.stringify(layer)}`);
    assert.equal(layer.typeSchemas?.entity?.bOnly, undefined, `C stored B's own type as the network's: ${JSON.stringify(layer)}`);
    assert.deepEqual(layer, layerOn('b', club.networkId, club.space), 'C\'s layer differs from the one B holds from A');
  });
});
