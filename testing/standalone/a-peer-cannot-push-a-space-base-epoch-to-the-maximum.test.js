/**
 * No peer can push a space's RDF base epoch to the schema maximum, by any door a peer reaches (Q-748, bundle-269 lens sweep, finding 1).
 *
 * At the maximum a space can never be rebased again: the next `baseEpoch` would be above what the setting or a round may carry. The
 * bound `RDF_OFFERED_EPOCH_MAX` already refused an OFFER above half the maximum, but two other doors took an epoch uncapped: the first
 * enable of a shared space adopts what arrives (`settleRdf` for a settings round or a layer), and a `space_rebase` round accepted any
 * epoch up to the maximum, so a member could propose it and a voter that did not read the number would pass it. One constant in the
 * schema package bounds all three, and this file drives each at the epoch the maximum names, at the bound and above it.
 *
 * Run: node --test testing/standalone/a-peer-cannot-push-a-space-base-epoch-to-the-maximum.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const schema = await import('../../schema/dist/index.js');
const settle = await import('../../server/dist/spaces/rdf-settle.js');
const shape = await import('../../server/dist/networks/round-shape.js');

const { RDF_BASE_EPOCH_MAX } = schema;
const BASE = 'https://peer.example.org/ld/notes/';
const VOCAB = `${BASE}vocab/`;

/** The bound the schema package names for an epoch a member takes from a peer; the cases below drive it by value, so each fails for the epoch and not for a missing name. */
const bound = schema.RDF_ADOPTED_EPOCH_MAX ?? Math.floor(RDF_BASE_EPOCH_MAX / 2);

describe('the bound', () => {
  it('the schema package names it', () => assert.equal(typeof schema.RDF_ADOPTED_EPOCH_MAX, 'number', 'the schema package exports no RDF_ADOPTED_EPOCH_MAX'));
  it('is a number well below the schema maximum, so a space adopted at it can still be rebased', () => {
    assert.ok(bound > 0 && bound <= RDF_BASE_EPOCH_MAX / 2, `${bound} leaves no room to rebase after an adoption`);
  });
  it('is the one bound the offers use too', () => {
    assert.equal(settle.RDF_OFFERED_EPOCH_MAX, undefined, 'rdf-settle still names a second bound of its own');
  });
});

describe('the first enable of a shared space adopts what arrives, within the bound', () => {
  for (const source of ['settings-round', 'layer']) {
    for (const [what, epoch] of [['the schema maximum', RDF_BASE_EPOCH_MAX], ['one above the bound', bound + 1]]) {
      it(`${source}: an epoch at ${what} is not adopted`, () => {
        const r = settle.settleRdf(undefined, { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: epoch }, source, { networkId: 'net-1' });
        assert.equal(r.ok, true);
        assert.ok((r.rdf?.baseEpoch ?? 0) <= bound, `the space adopted epoch ${r.rdf?.baseEpoch} from a peer`);
        assert.equal(r.rdf?.base, undefined, 'the base of an invalid offer was adopted');
      });
    }
    it(`${source}: an epoch at the bound is adopted as sent`, () => {
      const r = settle.settleRdf(undefined, { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: bound }, source, { networkId: 'net-1' });
      assert.equal(r.ok, true);
      assert.deepEqual(r.rdf, { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: bound });
    });
  }
});

describe('a space_rebase round carries an epoch within the bound', () => {
  const round = (epoch) => ({
    roundId: 'r1', type: 'space_rebase', subjectInstanceId: 'p1', openedAt: new Date().toISOString(), deadline: new Date().toISOString(),
    votes: [], spaceId: 'net-space-1', rebase: { base: BASE, vocab: VOCAB, epoch },
  });
  it('the schema maximum is malformed', () => assert.equal(shape.hasRoundShape(round(RDF_BASE_EPOCH_MAX)), false));
  it('one above the bound is malformed', () => assert.equal(shape.hasRoundShape(round(bound + 1)), false));
  it('the bound is well formed', () => assert.equal(shape.hasRoundShape(round(bound)), true));
  it('epoch 1 is well formed', () => assert.equal(shape.hasRoundShape(round(1)), true));
});
