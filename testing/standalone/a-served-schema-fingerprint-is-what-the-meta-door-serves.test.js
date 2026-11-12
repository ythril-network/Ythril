/**
 * The fingerprint a server tells a peer it SERVES a network (`links.served` of its schema snapshot) is the fingerprint of what `GET /api/sync/meta`
 * serves that network, whatever way the space holds its definitions (bundle-265, Q-738; the diff pass's F6).
 *
 * ## The rule
 *
 * `GET /meta` serves a member of network N the space's OWN definitions with N's layer laid over them, where "own" is `ownMeta` and, for a space that
 * never split its own from its effective meta (no `ownMeta`), the stored `meta`. `variationOf` fingerprints the same thing for `links.served`. The two
 * read it through ONE function (`servedMetaFor`, `sync/replicated-meta.ts`): `variationOf` once read `ownMeta` alone, so for a space with no `ownMeta` it
 * told a peer it served the layer by itself while the route served the layer over the space's own types, and a receiver comparing the two
 * fingerprints read an up-to-date member as behind.
 *
 * ## How it is driven
 *
 * The route's own handler answers the meta a peer would receive; its fingerprint is made by the server's own function (the fingerprint text of the
 * served meta with its library `$ref`s inlined, then `sha256`), and `variationOf(space).links.served` is read beside it. A second case holds the same
 * for a space that does have an `ownMeta`, so the fix is not a swap of one wrong reading for another.
 *
 * ## Seen red
 *
 * At the base of the fold (`variationOf` reading `space.ownMeta` alone) the first case fails: `links.served` is the fingerprint of the layer alone.
 *
 * Run: node --test testing/standalone/a-served-schema-fingerprint-is-what-the-meta-door-serves.test.js   (after `npm run build -w @ythril/server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';
import { sha256Hex, clone } from './_schema-fingerprint.mjs';

const dir = tempInstanceDir('ythril-served-fingerprint-');
const NET = 'net-served';
const ADMIN = Object.freeze({ rights: { instanceAdmin: true, perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } });

const type = (name) => ({ typeSchemas: { entity: { [name]: { propertySchemas: { p: { type: 'string' } } } } } });
const LAYER = type('from-the-network');
const OWN = type('mine');
const EFFECTIVE = { typeSchemas: { entity: { ...OWN.typeSchemas.entity, ...LAYER.typeSchemas.entity } } };

let loader, stamp, replicated, metaRouter, schemaValidation, textOf;

/** The fingerprint of what the meta door answers a member of NET for `spaceId`. */
async function fingerprintServed(spaceId) {
  const r = await callRoute(metaRouter, 'get', '/meta', { query: { spaceId, networkId: NET }, authToken: ADMIN });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  return sha256Hex(textOf(schemaValidation.inlineResolvableRefs(r.body.meta)));
}

describe('the fingerprint a space says it serves a network is the one its meta door serves', () => {
  before(async () => {
    ({ schemaFingerprintTextOf: textOf } = await import('../../schema/dist/internal.js'));
    loader = await bootInstance(dir, {
      instanceId: 'served-test',
      spaces: [
        // Never split its own definitions from its effective meta: no `ownMeta`, and `meta` holds what it runs on.
        { id: 'noown', label: 'noown', folders: [], meta: clone(EFFECTIVE) },
        { id: 'hasown', label: 'hasown', folders: [], meta: clone(EFFECTIVE), ownMeta: clone(OWN) },
      ],
      networks: [{
        id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: ['noown', 'hasown'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [], pendingRounds: [],
        schemaLayers: { noown: clone(LAYER), hasown: clone(LAYER) },
      }],
    });
    await import('../../server/dist/spaces/library-ref-expansion.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
    replicated = await import('../../server/dist/sync/replicated-meta.js');
    schemaValidation = await import('../../server/dist/spaces/schema-validation.js');
    metaRouter = (await import('../../server/dist/api/sync/meta.js')).syncMetaRouter;
  });
  after(() => removeInstanceDir(dir));

  it('a space with no ownMeta: links.served names the fingerprint of what GET /meta serves, the space\'s own types under the layer', async () => {
    const served = stamp.variationOf('noown').links.served;
    assert.equal(served.length, 1, JSON.stringify(served));
    assert.equal(served[0].networkId, NET);
    assert.equal(served[0].fp, await fingerprintServed('noown'),
      'links.served is not the fingerprint of the meta the door serves: a peer told it is served one schema is served another');
  });

  it('a space with an ownMeta: the same holds', async () => {
    const served = stamp.variationOf('hasown').links.served;
    assert.equal(served[0].fp, await fingerprintServed('hasown'));
  });

  it('the one reading of it is exported by the replicated-meta module, and the route and the snapshot writer both use its answer', () => {
    assert.equal(typeof replicated.servedMetaFor, 'function', 'servedMetaFor is not exported: the two readings are spelled apart again');
    const space = loader.getConfig().spaces.find(s => s.id === 'noown');
    const meta = replicated.servedMetaFor(space, { networkId: NET, meta: LAYER });
    assert.ok(meta.typeSchemas.entity['mine'] && meta.typeSchemas.entity['from-the-network'], 'a space with no ownMeta serves its stored meta under the layer');
  });
});
