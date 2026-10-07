/**
 * A peer's tombstone deletes a record here only on a STATED ground: the truth table of `authorises`, read through
 * `deliveryOf`, over every network type.
 *
 * ## The rule (D-14 = C, bundle-51)
 *
 * `server/src/sync/deletion-authority.ts` answers ONE question for records and files, both doors: *may this
 * delivery delete that object here?* The answer is ANY OF
 *
 *   - **absent target** — nothing held to delete; the tombstone is stored so this node can relay it. `ok`, ground
 *     `absent`, never a decline.
 *   - **issuer** — the delivery proves the issuer (a trusted admin relays any issuer; a peer must BE the issuer)
 *     AND `tombstoneGoverns(issuer, target author)` (same instance, or either side unknown).
 *   - **upstream** — the deliverer is this space's direct upstream on a DIRECTIONAL network (pub/sub subscriber,
 *     braintree child) AND the stored `deliveredBy` stamp of the target IS that deliverer. Whoever wrote the
 *     record, and whatever the issuer says: that is the D-14 ground, and the headline row below pins it.
 *
 * A decline names which half failed: `not_author` (the issuer proof held, authorship did not, upstream does not
 * apply), `not_upstream` (the deliverer is an upstream but the stamp is not its own), `not_issuer` (nothing else).
 *
 * ## Why a table over the whole product
 *
 * The defect class this repo produces most is one rule written twice with the weaker copy winning. This gate states
 * the rule over EVERY network type read out of the registry (`NetworkType` in `config/types-networks.ts`, so a
 * sixth type is covered the day it is added), every deliverer role, every kind of target author, every stamp and
 * every issuer claim — through `deliveryOf`, so the `upstream` bit is derived from a real config and not handed in.
 * The expected verdict is computed by a small oracle in this file, written from the rule above and not from the
 * module.
 *
 * ## Mutation that turns it red
 *
 * In `authorises`, drop the `target.deliveredBy === delivery.peerInstanceId` comparison (or make `upstream` true for
 * any directional member): the lateral-and-stamp rows and the self/lateral-writer survival rows go red. Make ground
 * `issuer` ignore `tombstoneGoverns`: the lateral-writer rows go red. Let `deliveryOf` treat a `both` pub/sub member
 * as upstream: the fail-closed rows go red.
 *
 * ## Two things written from the brief rather than from the code, so the first one to disagree edits one line
 *
 * - **Both grounds hold** (the deliverer is the issuer, governs, AND is the stamped upstream): the verdict is ground
 *   `issuer`, the one listed first. Decline precedence follows the brief's order the same way: when the issuer proof
 *   held and authorship failed AND the deliverer is an upstream with a stamp that is not its own, the reason is
 *   `not_author`.
 * - **An absent target is `ok` whatever the deliverer** (its own `it`, so one edit flips it if the owner reads "stored
 *   as today" as "still needs the issuer proof").
 *
 * Run: node --test testing/standalone/a-tombstone-is-honoured-only-on-a-stated-ground.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { NETWORK_TYPES, DIRECTIONAL_TYPES } from './_network-types.mjs';
import { SELF, P, L, T, N, SPACE, networkOf, cfgOf as cfgFor } from './_upstream-network-fixture.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/deletion-authority.js', import.meta.url); });
const mod = (rule) => needModule(loaded, ['authorises', 'deliveryOf'], rule);

/** Every network type, read out of the registry — a type added tomorrow lands in this table without an edit. */
const TYPES = NETWORK_TYPES;

/** The two types that have a position above this instance. The owner's word for them is "directional". */
const DIRECTIONAL = new Set(DIRECTIONAL_TYPES);

const cfgOf = (...networks) => cfgFor(networks);

/** Who delivers, as the door hands it to `deliveryOf`: a peer id, a trusted admin relay, or nobody in particular. */
const ROLES = {
  upstream:  { peerInstanceId: P },
  lateral:   { peerInstanceId: L },
  nonMember: { peerInstanceId: N },
  admin:     { trustedRelay: true },
  anonymous: {},
};

const AUTHORS = {
  self: { instanceId: SELF },
  lateralWriter: { instanceId: L },
  upstreamWriter: { instanceId: P },
  third: { instanceId: T },
  authorless: undefined,
  blank: { instanceId: '' },
  noInstance: {},
};

/** The oracle. Written from the rule in the docblock, never from the module under test. */
function expected({ trusted, deliverer, upstream }, issuer, target) {
  if (target === null) return { ok: true, ground: 'absent' };
  const author = target.author?.instanceId;
  const proof = trusted || (deliverer !== undefined && deliverer === issuer);
  const governs = !(issuer && author && issuer !== author);
  const stamped = upstream && typeof target.deliveredBy === 'string' && target.deliveredBy !== '' && target.deliveredBy === deliverer;
  if (proof && governs) return { ok: true, ground: 'issuer' };
  if (stamped) return { ok: true, ground: 'upstream' };
  if (proof) return { ok: false, reason: 'not_author' };
  if (upstream) return { ok: false, reason: 'not_upstream' };
  return { ok: false, reason: 'not_issuer' };
}

const shape = (v) => (v.ok ? { ok: true, ground: v.ground } : { ok: false, reason: v.reason });

function stampsFor(role, deliverer) {
  const another = role === 'upstream' ? L : P;
  const rows = [['byAnother', another], ['blank', ''], ['absent', undefined]];
  if (deliverer !== undefined) rows.unshift(['byThisDeliverer', deliverer]);
  return rows;
}

function issuersFor(deliverer) {
  const claims = [['aThirdInstance', T], ['theUpstreamClaimed', P], ['nobody', undefined]];
  if (deliverer !== undefined) claims.unshift(['theDeliverer', deliverer]);
  // The first name for a value wins: a deliverer that IS the upstream claims itself once, not twice.
  return claims.filter(([, v], i) => claims.findIndex(([, w]) => w === v) === i);
}

const describeRow = (r) => `${r.type}/${r.role} issuer=${r.issuerName}(${r.issuer}) author=${r.authorName} stamp=${r.stampName}(${r.stamp}) → expected ${JSON.stringify(r.want)}, got ${JSON.stringify(r.got)}`;

describe('the registry the table is read from', () => {
  it('lists every network type, directional ones among them', () => {
    // A floor: an unparsed registry would pass every loop below with nothing in it.
    assert.ok(TYPES.length >= 5, `read only ${TYPES.length} types out of types-networks.ts: ${TYPES}`);
    for (const d of DIRECTIONAL) assert.ok(TYPES.includes(d), `the directional type '${d}' is not in the registry any more — this table's notion of directional is stale`);
    assert.ok(TYPES.some(t => !DIRECTIONAL.has(t)), 'the table has no non-directional type to prove the negative with');
  });
});

for (const type of TYPES) {
  describe(`${type} network: delivery and verdict for every deliverer`, () => {
    for (const [role, auth] of Object.entries(ROLES)) {
      it(`${role}: deliveryOf names the deliverer and the upstream bit, authorises answers the oracle on every target`, () => {
        const { deliveryOf, authorises } = mod(`${type}/${role}`);
        const delivery = deliveryOf(cfgOf(networkOf(type)), SPACE, auth);

        const deliverer = auth.peerInstanceId;
        const upstream = DIRECTIONAL.has(type) && role === 'upstream';
        assert.equal(delivery.trustedRelay, auth.trustedRelay === true, `${type}/${role}: trustedRelay`);
        assert.equal(delivery.peerInstanceId, deliverer, `${type}/${role}: peerInstanceId`);
        assert.equal(delivery.upstream, upstream,
          `${type}/${role}: upstream — true only for the direct upstream of a directional network that carries the space`);

        const frame = { trusted: auth.trustedRelay === true, deliverer, upstream };
        const wrong = [];
        let rows = 0;

        for (const [issuerName, issuer] of issuersFor(deliverer)) {
          // The absent target is its own `it` below; here every target is held.
          for (const [authorName, author] of Object.entries(AUTHORS)) {
            for (const [stampName, stamp] of stampsFor(role, deliverer)) {
              const target = { ...(author === undefined ? {} : { author }), ...(stamp === undefined ? {} : { deliveredBy: stamp }) };
              const want = expected(frame, issuer, target);
              const got = shape(authorises(delivery, issuer, target, SELF));
              rows++;
              if (want.ok !== got.ok || want.ground !== got.ground || want.reason !== got.reason) {
                wrong.push(describeRow({ type, role, issuerName, issuer, authorName, stampName, stamp, want, got }));
              }
            }
          }
        }
        assert.ok(rows >= 28, `${type}/${role}: only ${rows} rows were checked`);
        assert.deepEqual(wrong, [], `${wrong.length} of ${rows} rows disagree with the rule:\n${wrong.join('\n')}`);
      });
    }
  });
}

describe('a space this network does not carry gives no upstream', () => {
  for (const type of TYPES.filter(t => DIRECTIONAL.has(t))) {
    it(`${type}: the upstream of a network that carries ANOTHER space is no upstream for this one`, () => {
      const { deliveryOf, authorises } = mod(`${type}/not-carried`);
      const delivery = deliveryOf(cfgOf(networkOf(type, { carries: false })), SPACE, { peerInstanceId: P });
      assert.equal(delivery.upstream, false);
      // P stamped the record and issued the tombstone for a record a third instance wrote: only the upstream ground
      // could delete it, and the space is not carried by the network P is upstream in.
      const v = authorises(delivery, P, { author: { instanceId: T }, deliveredBy: P }, SELF);
      assert.deepEqual(shape(v), { ok: false, reason: 'not_author' });
    });

    it(`${type}: a space carried under a local alias is still carried`, () => {
      const { deliveryOf } = mod(`${type}/alias`);
      const net = networkOf(type, { spaceMap: { 'remote-name': SPACE } });
      assert.equal(deliveryOf(cfgOf(net), SPACE, { peerInstanceId: P }).upstream, true,
        'the network lists the LOCAL id and maps the peer-side name onto it; the upstream is still the upstream');
    });
  }
});

describe('the upstream is derived from this instance\'s own records, and fails closed', () => {
  it('pubsub: a publisher stored `both` rather than `pull` is nobody\'s upstream', () => {
    const { deliveryOf } = mod('pubsub/both');
    assert.equal(deliveryOf(cfgOf(networkOf('pubsub', { pHasDirection: 'both' })), SPACE, { peerInstanceId: P }).upstream, false);
  });

  it('braintree: the root has no parent, so nobody is its upstream', () => {
    const { deliveryOf } = mod('braintree/root');
    const root = networkOf('braintree', { root: true });
    assert.equal(root.myParentInstanceId, undefined);
    for (const id of [P, L, N]) assert.equal(deliveryOf(cfgOf(root), SPACE, { peerInstanceId: id }).upstream, false, `${id}`);
  });

  it('braintree: a CHILD delivering up and a SIBLING are not the upstream', () => {
    const { deliveryOf } = mod('braintree/others');
    for (const id of ['inst-child', L]) {
      assert.equal(deliveryOf(cfgOf(networkOf('braintree')), SPACE, { peerInstanceId: id }).upstream, false, id);
    }
  });

  it('a space on two networks: the upstream of EITHER carrying network counts, one that carries another space does not', () => {
    const { deliveryOf } = mod('two networks');
    const club = networkOf('club');
    const pubsub = networkOf('pubsub');
    assert.equal(deliveryOf(cfgOf(club, pubsub), SPACE, { peerInstanceId: P }).upstream, true,
      'P is a club member AND the publisher: the directional network still names it');
    assert.equal(deliveryOf(cfgOf(club, networkOf('pubsub', { carries: false })), SPACE, { peerInstanceId: P }).upstream, false,
      'P is only a club member for this space');
    assert.equal(deliveryOf(cfgOf(club, pubsub), SPACE, { peerInstanceId: L }).upstream, false);
  });
});

describe('the headline row and the rows around it', () => {
  const D = (over = {}) => ({ peerInstanceId: P, trustedRelay: false, upstream: true, ...over });

  it('P is the upstream, issuer P, author X, stamped P: ok on the upstream ground though the issuer ground fails', () => {
    const { authorises } = mod('headline');
    assert.deepEqual(shape(authorises(D(), P, { author: { instanceId: T }, deliveredBy: P }, SELF)), { ok: true, ground: 'upstream' });
  });

  it('the same record, the same issuer, a lateral deliverer: declined, the record survives', () => {
    const { authorises } = mod('headline twin');
    assert.deepEqual(shape(authorises(D({ peerInstanceId: L, upstream: false }), L, { author: { instanceId: T }, deliveredBy: P }, SELF)),
      { ok: false, reason: 'not_author' });
  });

  it('this instance\'s own record is protected from a peer whose stamp it does not carry', () => {
    const { authorises } = mod('own record');
    // Locally written records carry the blank stamp: the upstream may not delete what this instance wrote.
    assert.deepEqual(shape(authorises(D(), P, { author: { instanceId: SELF }, deliveredBy: '' }, SELF)),
      { ok: false, reason: 'not_author' });
  });

  it('a blank stamp is no stamp: `deliveredBy: \'\'` never equals a deliverer', () => {
    const { authorises } = mod('blank stamp');
    assert.deepEqual(shape(authorises(D({ peerInstanceId: '' }), 'x', { author: { instanceId: T }, deliveredBy: '' }, SELF)).ok, false);
  });

  it('both grounds hold: the issuer ground is the one named', () => {
    const { authorises } = mod('both grounds');
    assert.deepEqual(shape(authorises(D(), P, { author: { instanceId: P }, deliveredBy: P }, SELF)), { ok: true, ground: 'issuer' });
  });

  it('a trusted admin relay needs no peer and no stamp, but still respects authorship', () => {
    const { authorises } = mod('trusted relay');
    const admin = { peerInstanceId: undefined, trustedRelay: true, upstream: false };
    assert.deepEqual(shape(authorises(admin, T, { author: { instanceId: T } }, SELF)), { ok: true, ground: 'issuer' });
    assert.deepEqual(shape(authorises(admin, T, { author: { instanceId: L } }, SELF)), { ok: false, reason: 'not_author' });
  });
});

describe('an absent target', () => {
  it('is ok on the `absent` ground for every deliverer — stored so this node can relay it, deleting nothing', () => {
    const { deliveryOf, authorises } = mod('absent target');
    let rows = 0;
    for (const type of TYPES) {
      for (const [role, auth] of Object.entries(ROLES)) {
        const delivery = deliveryOf(cfgOf(networkOf(type)), SPACE, auth);
        for (const issuer of [P, L, T, undefined]) {
          assert.deepEqual(shape(authorises(delivery, issuer, null, SELF)), { ok: true, ground: 'absent' },
            `${type}/${role} issuer ${issuer}`);
          rows++;
        }
      }
    }
    assert.ok(rows >= 100, `only ${rows} rows`);
  });
});
