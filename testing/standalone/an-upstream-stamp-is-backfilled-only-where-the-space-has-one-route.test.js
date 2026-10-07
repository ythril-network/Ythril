/**
 * A row stored before the `deliveredBy` stamp existed is stamped ONCE, with the upstream — and only where the
 * upstream is the only way a record could have reached this space.
 *
 * ## The rule (`backfillStamp`, plan §1)
 *
 * The stamp of a pre-release row is the upstream's instance id when ALL of these hold, and `''` otherwise:
 *
 *   1. every network that carries the space is DIRECTIONAL (pub/sub, braintree) and they all have the same
 *      upstream — no mesh, club, closed or democratic network carries it, and this instance is not the publisher /
 *      root of one of them (nobody is above it there);
 *   2. no peer token OUTSIDE the networks' membership reaches the space (`peerTokensReaching` minus members): a
 *      peer with a token and no member row is a second route an unstamped record could have arrived by;
 *   3. the row's author is non-empty and is not this instance — a record this instance wrote is never the
 *      upstream's to delete, and an author-less one proves nothing.
 *
 * ## Why it errs toward `''`
 *
 * `''` means "no peer relayed this": the upstream ground cannot delete it, so the one-time repair leaves it be.
 * A stamp given to a row the upstream did not deliver hands the upstream the power to delete data it never sent — the
 * cost the owner accepted for rows it DID relay (D-14 = C), and not one more row than that.
 *
 * ## Mutation that turns it red
 *
 * Drop rule 1's "no non-directional network" half (a space also on a club stamps the upstream), drop the unlisted-token
 * half, let a self-authored or blank-author row take the stamp, or stamp when the two directional networks name
 * different upstreams. Each has its own rows below.
 *
 * Run: node --test testing/standalone/an-upstream-stamp-is-backfilled-only-where-the-space-has-one-route.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { NON_DIRECTIONAL_TYPES, DIRECTIONAL_TYPES } from './_network-types.mjs';
import { SELF, P, L, T, SPACE, ELSEWHERE, networkOf, cfgOf, peerToken } from './_upstream-network-fixture.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/deletion-authority.js', import.meta.url); });
const mod = (rule) => needModule(loaded, ['backfillStamp'], rule);

const UNLISTED = 'inst-unlisted-peer';
const OTHER_UP = 'inst-other-upstream';
const rowBy = (instanceId) => ({ author: { instanceId } });

/** Every shape the stamp may be asked about, with what a FOREIGN author's row is stamped. */
const SPACES = [
  // ── one route: the upstream ───────────────────────────────────────────────────────────────────────────────
  ['pubsub subscriber, P is the publisher', cfgOf([networkOf('pubsub')]), P],
  ['braintree child, P is the parent', cfgOf([networkOf('braintree')]), P],
  ['a pubsub and a braintree that name the SAME upstream', cfgOf([networkOf('pubsub'), networkOf('braintree')]), P],
  ['two pubsub networks, one upstream', cfgOf([networkOf('pubsub', { id: 'net-a' }), networkOf('pubsub', { id: 'net-b' })]), P],
  ['one route even with a token for the upstream itself (a member is not an unlisted peer)', cfgOf([networkOf('pubsub')], [peerToken(P, [SPACE])]), P],
  ['one route even with a token for a lateral MEMBER of the network', cfgOf([networkOf('pubsub')], [peerToken(L, [SPACE])]), P],
  ['a peer token that reaches only ANOTHER space is no second route', cfgOf([networkOf('pubsub')], [peerToken(UNLISTED, [ELSEWHERE])]), P],
  ['a peer token with no rights matrix reaches nothing', cfgOf([networkOf('pubsub')], [{ id: 'tok-x', peerInstanceId: UNLISTED }]), P],
  ['a mesh network that carries ANOTHER space does not make this space meshed', cfgOf([networkOf('pubsub'), networkOf('club', { carries: false })]), P],
  // ── more than one route, or none above: '' ─────────────────────────────────────────────────────────────
  ['two directional networks with DIFFERENT upstreams', cfgOf([networkOf('pubsub'), networkOf('braintree', { parent: OTHER_UP })]), ''],
  ['this instance is the pubsub PUBLISHER: nobody is above it', cfgOf([networkOf('pubsub', { publisher: true })]), ''],
  ['this instance is the braintree ROOT: nobody is above it', cfgOf([networkOf('braintree', { root: true })]), ''],
  ['the publisher of one network and the subscriber of another', cfgOf([networkOf('pubsub', { publisher: true, id: 'net-pub' }), networkOf('pubsub', { id: 'net-sub' })]), ''],
  ['an unlisted peer token reaches the space', cfgOf([networkOf('pubsub')], [peerToken(UNLISTED, [SPACE])]), ''],
  ['an unlisted peer token with an unscoped floor reaches every space', cfgOf([networkOf('pubsub')], [{
    id: 'tok-floor', peerInstanceId: UNLISTED, rights: { perSpace: {}, floor: { knowledge: 'read', files: 'read', schema: 'read', dataQuality: 'read', networks: 'none' } },
  }]), ''],
  ['no network carries the space', cfgOf([networkOf('pubsub', { carries: false })]), ''],
  ['no network at all', cfgOf([]), ''],
  // Every directional type beside every non-directional one the registry holds: derived, so a new mesh-like type is covered.
  ...DIRECTIONAL_TYPES.flatMap(d => NON_DIRECTIONAL_TYPES.map(n => [
    `a ${d} network AND a ${n} network carry the space`, cfgOf([networkOf(d), networkOf(n)]), '',
  ])),
  ...NON_DIRECTIONAL_TYPES.map(n => [`only a ${n} network carries the space`, cfgOf([networkOf(n)]), '']),
];

describe('backfillStamp: which spaces have exactly one route', () => {
  it('has rows for both outcomes and for every non-directional type', () => {
    // A floor: a table built over nothing passes everything.
    assert.ok(SPACES.length >= 20, `only ${SPACES.length} rows`);
    assert.ok(SPACES.some(([, , want]) => want === P) && SPACES.some(([, , want]) => want === ''));
    for (const n of NON_DIRECTIONAL_TYPES) assert.ok(SPACES.some(([name]) => name.includes(` ${n} network`)), `no row for ${n}`);
  });

  for (const [name, cfg, want] of SPACES) {
    it(`${name}: a foreign author's row is stamped ${JSON.stringify(want)}`, () => {
      const { backfillStamp } = mod(name);
      assert.equal(backfillStamp(cfg, SPACE, rowBy(T), SELF), want);
    });
  }
});

describe('backfillStamp: which authors', () => {
  const single = cfgOf([networkOf('pubsub')]);

  it('a row this instance wrote is never the upstream\'s', () => {
    const { backfillStamp } = mod('self author');
    assert.equal(backfillStamp(single, SPACE, rowBy(SELF), SELF), '');
  });

  it('a blank, missing or instance-less author proves nothing and is not stamped', () => {
    const { backfillStamp } = mod('empty author');
    for (const row of [rowBy(''), {}, { author: {} }, { author: undefined }]) {
      assert.equal(backfillStamp(single, SPACE, row, SELF), '', JSON.stringify(row));
    }
  });

  it('the upstream\'s own row and a third instance\'s row are both foreign, so both are stamped', () => {
    const { backfillStamp } = mod('foreign authors');
    for (const author of [P, L, T]) assert.equal(backfillStamp(single, SPACE, rowBy(author), SELF), P, author);
  });

  it('the answer is a string for every combination — never undefined, never null', () => {
    const { backfillStamp } = mod('always a string');
    for (const [, cfg] of SPACES) {
      for (const row of [rowBy(T), rowBy(SELF), rowBy(''), {}]) {
        assert.equal(typeof backfillStamp(cfg, SPACE, row, SELF), 'string');
      }
    }
  });
});
