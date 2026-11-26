/**
 * A round a peer serves of a kind this network's type never opens is said at warn, once per network, member and window (Q-968, lens B).
 *
 * ## What it prevents
 *
 * A join or removal round on a club or pub/sub network is a peer's forgery: the network admits and removes members directly, so no honest
 * member opens one, and adoption refuses it. The refusal was counted and said at debug only, a level a default log never shows, so an
 * operator whose peer was forging rounds saw nothing. Now it is a warn line, through the one rate limit the refused governance pulls use,
 * so a peer that serves the round on every cycle is one line, not one per cycle.
 *
 * ## What is held
 *
 * - the first cycle that meets such a round says one warn line naming the peer and the network;
 * - the next cycle, the same peer and the same round: no second line (once per window);
 * - a round the publisher refuses as "proposed by a subscriber" is NOT said at warn: an older subscriber opens one honestly, so it stays debug.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`) and a non-loopback address (`_private-address.mjs`), then
 *      node --test testing/standalone/a-served-round-of-a-never-opened-kind-is-warned-once-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER_LABEL } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'govwarn';
let door, loader;

/** A live round of `type` as a peer serves it: dated, one yes of the peer's own. */
const served = (roundId, type, over = {}) => ({
  roundId, type, subjectInstanceId: 'subject-1', subjectLabel: 'Subject', subjectUrl: 'https://subject.example',
  deadline: new Date(Date.now() + 86_400_000).toISOString(), openedAt: new Date().toISOString(), votes: [], ...over,
});
let asked = 0;
const serving = (rounds) => {
  asked = 0;
  door.state.network = (req, res, next) => {
    if (req.method === 'GET' && req.path.endsWith('/votes')) { asked++; res.json({ rounds }); return; }
    next();
  };
};
const network = () => loader.getConfig().networks.find(n => n.id === door.NET);
/** The warn lines one cycle said about a round the network never opens. */
const neverOpenedWarnings = async () => (await door.logsDuring(() => door.sync())).lines.filter(l => /never opens/.test(l));

describe('a served round of a kind the network never opens is warned, once', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'govwarn', spaces: [S] });
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    network().pendingRounds = [];
  });

  it('a round a subscriber proposed, refused by the publisher, stays at debug: no warn line', async () => {
    door.configure({ direction: 'push' });
    serving([served('r-sub', 'meta_change', { spaceId: S, pendingMeta: { purpose: 'x' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 })]);
    assert.deepEqual(await neverOpenedWarnings(), []);
    assert.ok(asked > 0, 'fixture check: the publisher never pulled the peer\'s votes, so the case proves nothing about the log');
    assert.deepEqual(network().pendingRounds, [], 'fixture check: the publisher adopted a subscriber\'s round, so it was not refused');
  });

  it('a join round served on pub/sub: one warn line naming the peer and the network, and no second on the next cycle', async () => {
    serving([served('r-join', 'join', { pendingMember: { instanceId: 'subject-1', label: 'Subject', url: 'https://subject.example', tokenHash: 'h', direction: 'both' } })]);
    const first = await neverOpenedWarnings();
    assert.ok(asked > 0, 'fixture check: the subscriber never pulled the peer\'s votes');
    assert.equal(first.length, 1, `the first cycle said ${first.length} warn line(s) about a round of a kind the network never opens: ${first.join(' | ')}`);
    assert.ok(first[0].includes(PEER_LABEL) && first[0].includes(door.NET), `the line names neither the peer nor the network: ${first[0]}`);
    assert.deepEqual(network().pendingRounds, [], 'fixture check: the round was adopted, so it was not refused for its kind');
    assert.deepEqual(await neverOpenedWarnings(), [], 'a second cycle with the same peer said it again within the window');
  });
});
