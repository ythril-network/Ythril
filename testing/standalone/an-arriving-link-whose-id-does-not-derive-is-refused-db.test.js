/**
 * An arriving link whose `_id` is not the one its endpoints derive (`linkIdFor`) is refused, on the push door and on the
 * pull door alike, counted as rejected, and named in the log (Q-222).
 *
 * ## The defect
 *
 * A link's id is derived from its endpoints, so one relationship has exactly one id on every instance that follows the
 * rule. The wire schema takes any non-empty `_id`, and the planner stored whatever arrived: a link under a forged or stale
 * id sat beside the derived row a peer holds for the same relationship, answered `duplicate` by the peer's unique endpoint
 * index on delivery, and differed in the Merkle leaf for ever.
 *
 * ## What is asserted
 *
 * - PUSH: a link under a random id is answered `rejected: 1` (and nothing `upserted`), stores nothing, and the log names its
 *   id; a link under its derived id, in the same page, lands;
 * - PULL: the same two links in one pulled page — the derived one lands, the other is not stored and is named in the log;
 * - both doors judge it the same: one planner (`planArrivals`), so a difference between the doors is the defect this
 *   repository produces most.
 *
 * Run: node --test testing/standalone/an-arriving-link-whose-id-does-not-derive-is-refused-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'underived';
let door, linkIdFor;

const links = () => door.mongo.col(`${S}_links`);

/** One link between two fresh endpoints, under `_id` (default: the id the endpoints derive). */
function linkOf(seq, over = {}) {
  const [from, to] = [randomUUID(), randomUUID()];
  const _id = over._id ?? linkIdFor(from, 'fact', to, 'entity');
  return build.link(S, _id, seq, { from, to, fromKind: 'fact', toKind: 'entity', ...over });
}

describe('an arriving link whose id does not derive is refused', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'underived', spaces: [S], direction: 'push' });
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'push' });
    await links().deleteMany({});
  });

  it('push: a link under a random id is rejected, not stored and named; its derived-id page-mate lands', async () => {
    const good = linkOf(1);
    const bad = linkOf(2, { _id: randomUUID() });
    const { result: r, lines } = await logLinesDuring(() => door.push('/batch-upsert', { links: [good, bad] }, { spaceId: S }));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.links.rejected, 1, `the refusal was not counted as rejected: ${JSON.stringify(r.body.links)}`);
    assert.equal(r.body.links.upserted, 1, `the derived link was not stored: ${JSON.stringify(r.body.links)}`);
    assert.ok(await links().findOne({ _id: good._id }), 'the link under its derived id did not land');
    assert.equal(await links().findOne({ _id: bad._id }), null, 'a link under an id that does not derive was stored');
    assert.ok(lines.some(l => l.includes(bad._id) && /derive/.test(l)),
      `the log does not name the refused id and why: ${JSON.stringify(lines)}`);
  });

  // The review of bundle-45, #11: an operator can alert on the refusal without reading the log.
  it('push: the refusal is counted, by family and verdict', async () => {
    const { syncArrivalsSetAsideTotal } = await import('../../server/dist/metrics/registry.js');
    const valueOf = async () => (await syncArrivalsSetAsideTotal.get()).values.find(v => v.labels.family === 'links' && v.labels.verdict === 'underivedId')?.value ?? 0;
    const before = await valueOf();
    const r = await door.push('/batch-upsert', { links: [linkOf(1), linkOf(2, { _id: randomUUID() }), linkOf(3, { _id: randomUUID() })] }, { spaceId: S });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(await valueOf() - before, 2, 'the two refused links were not counted as underivedId');
  });

  it('pull: the same page — the derived link lands, the other is not stored and is named', async () => {
    await door.reset({ direction: 'pull' });
    const remote = door.remoteOf(S);
    const good = linkOf(1, { spaceId: remote, author: { ...PEER_AUTHOR } });
    const bad = linkOf(2, { _id: randomUUID(), spaceId: remote, author: { ...PEER_AUTHOR } });
    door.state.records[remote] = { links: [good, bad] };
    const { lines } = await logLinesDuring(() => door.sync());
    assert.ok(await links().findOne({ _id: good._id }), 'the link under its derived id did not land — the fixture is broken');
    assert.equal(await links().findOne({ _id: bad._id }), null, 'a pulled link under an id that does not derive was stored');
    assert.ok(lines.some(l => l.includes(bad._id) && /derive/.test(l)),
      `the log does not name the refused id and why: ${JSON.stringify(lines)}`);
  });
});
