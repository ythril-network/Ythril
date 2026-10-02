/**
 * A page of peer tombstones costs the same number of database commands whatever its size — on the push door and the
 * pull door, per tombstone type (bundle-46 plan row 7).
 *
 * ## What it costs today
 *
 * Each tombstone is applied on its own: an upsert of the tombstone, a read of it back, a read of its target and a
 * delete — `4N` round trips, so a 5000-element pull page is 20 000 sequential commands. That is also what made a
 * re-pull after a capped watermark expensive, and the plan's answer to that cost (one watermark, re-pulled cheaply)
 * holds only while a page is a handful of round trips.
 *
 * ## The rule
 *
 * A page of 200 tombstones, each deleting a record its issuer authored, issues EXACTLY as many commands against the
 * receiving space's collections as a page of 20, for every tombstone type, once the collections are warm. Counted:
 * the commands addressed to `<space>_*` — the apply's own cost. The fake peer's reads (its own `peer-<space>`
 * collections) and the counter are outside that scope by construction.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-tombstone-page-costs-the-same-at-any-size-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tscost';
/** The tombstone vocabulary, derived — read at load because the cases are registered per type. */
const { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } = await import('../../server/dist/config/types.js');
let door, searchIndexPresenceSettled;
let seq = 0;

/** A record of the tombstone's collection, authored by `issuer`, that the tombstone deletes. */
const TARGET = {
  facts: (id, a) => build.fact(S, id, 1, { author: a }),
  entities: (id, a) => build.entity(S, id, 1, { author: a }),
  edges: (id, a) => build.edge(S, id, 1, { author: a }),
  chrono: (id, a) => build.chrono(S, id, 1, { author: a }),
  links: (id, a) => build.link(S, id, 1, { author: a }),
};

async function cost(door_, type, n, tag) {
  const issuer = door_ === 'push' ? PEER_TOKEN.peerInstanceId : PEER;
  const coll = TOMBSTONE_COLLECTION[type];
  const author = { instanceId: issuer, instanceLabel: issuer };
  const ids = Array.from({ length: n }, (_, i) => `${type}-${tag}-${i}`);
  // Both sides emptied and the watermark forgotten, so a pull serves this page and nothing a previous one left.
  await door.reset({ direction: 'pull' });
  await door.coll(S, coll).insertMany(ids.map(id => TARGET[coll](id, author)));
  const page = ids.map(id => build.tombstone(S, id, type, ++seq, { instanceId: issuer }));
  if (door_ === 'pull') await door.seedPeer(S, page);
  await door.settled();
  const seen = await door.commandsDuring(async () => {
    if (door_ === 'push') {
      const res = await door.push('/tombstones', { tombstones: page }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
    } else {
      await door.sync();
    }
    await door.settled();
    await searchIndexPresenceSettled(S);
  });
  assert.equal(await door.coll(S, coll).countDocuments({ _id: { $in: ids } }), 0, `${type}: the page did not delete its targets`);
  return seen.filter(c => c.split(' ')[1]?.startsWith(`${S}_`));
}

describe('a page of peer tombstones costs the same at any size', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tscost', spaces: [S], monitorCommands: true });
    ({ searchIndexPresenceSettled } = await import('../../server/dist/spaces/search-index-presence.js'));
  });
  after(async () => { await door?.close(); });

  it('the type set is derived and monitoring sees commands', async () => {
    assert.ok(TOMBSTONE_TYPES.length >= 5, `only ${TOMBSTONE_TYPES.length} tombstone type(s) — the vocabulary did not load`);
    assert.deepEqual(TOMBSTONE_TYPES.map(t => TOMBSTONE_COLLECTION[t]).filter(c => !TARGET[c]), [],
      'a tombstone type with no target fixture goes unchecked');
    const seen = await cost('push', TOMBSTONE_TYPES[0], 2, 'probe');
    assert.ok(seen.length >= 1, 'command monitoring recorded nothing in scope, so every comparison below would pass vacuously');
  });

  for (const via of ['push', 'pull']) {
    describe(via, () => {
      for (const type of TOMBSTONE_TYPES) {
        it(`${type}: a 200-tombstone page issues as many commands as a 20-tombstone page`, async () => {
          await cost(via, type, 5, `${via}-warm`);
          const small = await cost(via, type, 20, `${via}-small`);
          const large = await cost(via, type, 200, `${via}-large`);
          assert.equal(large.length, small.length,
            `${via} ${type}: 20 tombstones cost ${small.length} commands and 200 cost ${large.length} — the page is applied `
            + `one tombstone at a time. First commands of the large page: ${large.slice(0, 6).join('; ')}`);
        });
      }
    });
  }
});
