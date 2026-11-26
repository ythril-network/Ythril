/**
 * The per-space mark that a member holds a voted network's whole schema (`NetworkConfig.schemaLayerSeeded`, `Q-966`) follows its space
 * (lens sweep: the mark's three moves were untested).
 *
 * A mark left under a space's old id after a rename reads as unseeded under the new one, and the heal then replaces a whole layer with
 * whatever its admitter answers; a mark that outlives its space leaves a stale entry for a space created later under the same id, which then
 * never heals. The three moves, each on the config shape itself:
 *
 * - a rename moves it with the layer (`applySpaceRenameToConfig`);
 * - the space leaving the network clears it (`takeSpaceOutOfNetwork`);
 * - the boot re-key of what an older rename left under the old id moves it with the layer (`migrateNetworkSpaceKeys`).
 *
 * Run: node --test testing/standalone/a-schema-layer-mark-follows-its-space-through-rename-leave-and-rekey.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { applySpaceRenameToConfig } = await import('../../server/dist/spaces/rename.js');
const { takeSpaceOutOfNetwork } = await import('../../server/dist/networks/take-space-out-of-network.js');
const { migrateNetworkSpaceKeys } = await import('../../server/dist/config/migrate-network-space-keys.js');

const network = (extra = {}) => ({
  id: 'net-1', label: 'n', type: 'club', spaces: ['old'], members: [], pendingRounds: [], votingDeadlineHours: 24,
  schemaLayers: { old: { purpose: 'the layer' } }, schemaLayerSeeded: { old: 'layer', other: 'own' }, ...extra,
});

describe('the seeded mark of a space', () => {
  it('moves with the space when it is renamed, and leaves the other spaces\' marks alone', () => {
    const space = { id: 'old', label: 'old', folders: [], meta: {} };
    const cfg = { spaces: [space], networks: [network()], tokens: [], retiredSpaceIds: [] };
    applySpaceRenameToConfig(cfg, space, 'old', 'new');
    assert.deepEqual(cfg.networks[0].schemaLayerSeeded, { new: 'layer', other: 'own' }, 'the mark stayed under the old id');
  });

  it('is cleared when the space leaves the network', () => {
    const net = network();
    const out = takeSpaceOutOfNetwork(net, 'old');
    assert.equal(out.carried, true);
    assert.deepEqual(net.schemaLayerSeeded, { other: 'own' }, 'the mark outlived its space');
  });

  it('is re-keyed at boot with the layer an older rename left under the old id', () => {
    const net = network({ spaces: ['new'], spaceMap: { old: 'new' }, schemaLayers: { old: { purpose: 'the layer' } } });
    assert.equal(migrateNetworkSpaceKeys({ networks: [net] }), true);
    assert.deepEqual(net.schemaLayers, { new: { purpose: 'the layer' } });
    assert.deepEqual(net.schemaLayerSeeded, { new: 'layer', other: 'own' }, 'the layer was re-keyed and its mark was not');
  });
});
