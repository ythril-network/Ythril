/**
 * A round a peer serves is validated against the shape the server DECLARES for it, canonicalised where that is safe, refused only where it is
 * unsafe, and never trusted for a field it does not declare (bundle-106, §3.6 v5, X11, SEC S4, DI S3, INT S5, INT S6).
 *
 * ## The rows
 *
 * - **R-X11a** `wipeTypes` a string and `spaceId` an object: not adopted, counted as `malformed`, and the cycle is green. Today adoption
 *   keeps every field it is handed, so a later reader (`networkSpaceKey`, the hold, the runner's key) meets a string where it iterates and
 *   an object where it compares, and throws inside a rename or a delete.
 * - **R-X11b** `wipeTypes: ['files','facts','files']` is ADOPTED and stored `['facts','files']` (deduped, in `WIPE_COLLECTION_TYPES`
 *   order): an older proposer stored the caller's list as sent, so refusing a non-canonical list would refuse legitimate old-build rounds on
 *   every new member. The signature side of the same fact: a cast's `bsig` binds the sorted AND deduped list, so one signed over
 *   `['files','files']` and the stored `['files']` read the same message.
 * - **R-X11c** a cast with no `bsig` and no `castAt` is adopted, and is stamped at receipt — an older or unsigned cast is never refused for
 *   lacking them.
 * - **R-X11d** an `openedAt` a day ahead is ADOPTED (the future bound refuses no round), counted in `ythril_round_clock_ahead_total`, and
 *   warned once per network and peer, not once per round. An unknown key (`futureField`) survives into the stored round and into the copy
 *   this instance serves: `.passthrough()`, never strip, never `.strict()`.
 *
 * ## How it is driven
 *
 * The receiving side is `runSyncForPeer` (the engine's own gossip) against a peer that answers over HTTP; what the receiver then serves is
 * read from the REAL votes route. The receiver carries no space and its peer is current, so the cycle runs governance and ends clean.
 *
 * ## Seen red
 *
 * At a638e702: R-X11a (the malformed round is adopted whole), R-X11b (the list is stored as sent, and `roundTargetFields` does not dedupe),
 * R-X11d's counter and once-warning (neither exists). R-X11c and the `futureField` half of R-X11d are CONTROLS: adoption keeps unknown keys
 * today, and the design says it must keep doing so; they hold the behaviour a strict or stripping schema would break. After the fix, by hand:
 * refuse non-canonical `wipeTypes` -> R-X11b red; require `castAt` or `bsig` -> R-X11c red; refuse a future `openedAt` -> R-X11d red; strip
 * unknown keys -> `futureField` red.
 *
 * Run: node --test testing/standalone/a-served-round-is-adopted-by-its-declared-shape.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, counterTotal, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { callRouteAfterAuth } from './_route-after-auth.mjs';
import { startVotesPeer, SELF, P1, P2 } from './_vote-round-sites.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';

const dir = tempInstanceDir('ythril-round-shape-');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const NET = 'receiver';

const member = (instanceId, extra = {}) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
const wireRound = (roundId, over = {}) => ({
  roundId, type: 'space_wipe', spaceId: 'notes', subjectInstanceId: P2, subjectLabel: 'Proposer', subjectUrl: '',
  openedAt: iso(T - HOUR), deadline: iso(T + 23 * HOUR), votes: [], concluded: false, ...over,
});

describe('what adoption does with the shape of a served round', { skip: privateAddressSkipReason() }, () => {
  let peer, loader, logs, warned, clockAheadBefore, stored, served;
  const round = (id) => loader.getConfig().networks.find(n => n.id === NET).pendingRounds.find(r => r.roundId === id);

  before(async () => {
    allowEngineToDialPrivatePeers();
    peer = await startVotesPeer();
    loader = await bootInstance(dir, {
      instanceId: SELF, peerTokens: { [P1]: 'token-p1' },
      networks: [{
        id: NET, label: 'Receiver', type: 'closed', origin: 'created', syncSchedule: '', spaces: [], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [member(P1, { url: 'will-be-set', version: '99.0.0', versionCheckedAt: iso(T - HOUR) }), member(P2)],
      }],
    });
    loader.getConfig().networks[0].members[0].url = peer.url;

    peer.serve([
      wireRound('x11a-string-types', { wipeTypes: 'files', spaceId: { nested: true } }),
      wireRound('x11b-duplicates', { wipeTypes: ['files', 'facts', 'files'] }),
      wireRound('x11c-bare-cast', { votes: [{ instanceId: P1, vote: 'yes' }] }),
      wireRound('x11d-ahead-1', { openedAt: iso(T + DAY), deadline: iso(T + DAY + 24 * HOUR), futureField: { kept: 'as sent' } }),
      wireRound('x11d-ahead-2', { openedAt: iso(T + DAY), deadline: iso(T + DAY + 24 * HOUR) }),
    ]);

    const { log } = await import('../../server/dist/util/log.js');
    const orig = { debug: log.debug, info: log.info, warn: log.warn, error: log.error };
    logs = [];
    for (const k of Object.keys(orig)) log[k] = (...a) => { logs.push(`${k}: ${a.join(' ')}`); };
    clockAheadBefore = await counterTotal('ythril_round_clock_ahead_total');
    try {
      const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
      await runSyncForPeer(P1);
      await settled(() => (loader.getConfig().networks.find(n => n.id === NET)?.pendingRounds ?? []).map(r => r.roundId).sort());
    } finally { Object.assign(log, orig); }
    warned = logs.filter(l => l.startsWith('warn:') && /clock|ahead|openedAt/i.test(l));

    stored = Object.fromEntries(['x11a-string-types', 'x11b-duplicates', 'x11c-bare-cast', 'x11d-ahead-1', 'x11d-ahead-2'].map(id => [id, round(id)]));
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    served = await callRouteAfterAuth(syncVotesRouter, 'get', '/networks/:networkId/votes', { params: { networkId: NET }, authToken: { peerInstanceId: P1, rights: { instanceAdmin: false } } });
  });
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  it('R-X11a: a string wipeTypes and an object spaceId are not adopted, said as malformed, and the cycle stayed green', () => {
    assert.equal(stored['x11a-string-types'], undefined,
      `the malformed round was adopted whole (wipeTypes ${JSON.stringify(stored['x11a-string-types']?.wipeTypes)}, spaceId ${JSON.stringify(stored['x11a-string-types']?.spaceId)}): every later reader iterates a string and compares an object`);
    assert.ok(logs.some(l => /malformed/.test(l)), `nothing said a round was refused as malformed: ${logs.slice(-6).join(' | ')}`);
    assert.ok(!logs.some(l => /^error:/.test(l)), `the cycle logged an error: ${logs.filter(l => /^error:/.test(l)).join(' | ')}`);
  });

  it('R-X11b: a duplicated, unordered wipeTypes is adopted and stored canonical', () => {
    assert.ok(stored['x11b-duplicates'], 'a legitimate old-build round with a repeated type was refused: refusing non-canonical lists refuses every older proposer');
    assert.deepEqual(stored['x11b-duplicates'].wipeTypes, ['facts', 'files'], 'stored as sent, not deduped and put in collection order');
  });

  it('R-X11b: a cast signed over a duplicated list and the stored deduped list bind the same message', async () => {
    const { voteCastBoundMessage } = await import('../../server/dist/util/signing.js');
    const base = { networkId: NET, roundId: 'r', subjectInstanceId: P2, instanceId: P1, vote: 'yes' };
    const target = { type: 'space_wipe', spaceId: 'notes', networkSpaceId: undefined };
    assert.equal(
      voteCastBoundMessage({ ...base, round: { ...target, wipeTypes: ['files', 'files'] } }),
      voteCastBoundMessage({ ...base, round: { ...target, wipeTypes: ['files'] } }),
      'a signature over a list with a duplicate does not verify against the deduped list adoption stores');
    assert.equal(
      voteCastBoundMessage({ ...base, round: { ...target, wipeTypes: ['files', 'facts'] } }),
      voteCastBoundMessage({ ...base, round: { ...target, wipeTypes: ['facts', 'files'] } }),
      'the order of the list must keep mattering nothing to a signature');
  });

  it('R-X11c control: a cast with no bsig and no castAt is adopted with its round and merged', () => {
    const r = stored['x11c-bare-cast'];
    assert.ok(r, 'the round carrying a bare cast was refused: an older or unsigned cast is never refused for lacking castAt or bsig');
    assert.ok(r.votes.some(v => v.instanceId === P1), 'the bare cast of the reporting voter was not merged');
  });

  it('R-X11c: that cast is stamped at receipt, so no reader meets a cast without a date', () => {
    const cast = stored['x11c-bare-cast']?.votes.find(v => v.instanceId === P1);
    assert.ok(cast, 'the bare cast is not there to be stamped');
    assert.ok(Number.isFinite(Date.parse(cast.castAt)), `the cast was not stamped at receipt: castAt ${JSON.stringify(cast.castAt)}`);
  });

  it('R-X11d: an openedAt a day ahead is adopted, counted, and warned once per network and peer', async () => {
    assert.ok(stored['x11d-ahead-1'] && stored['x11d-ahead-2'], 'a round whose proposer clock runs ahead was refused: the future bound refuses no round type');
    const after = await counterTotal('ythril_round_clock_ahead_total');
    assert.equal(after - clockAheadBefore, 2, 'ythril_round_clock_ahead_total did not count the two ahead-dated rounds (or does not exist)');
    assert.equal(warned.length, 1, `the clock requirement was said ${warned.length} times for one peer in one pass: ${warned.join(' | ')}`);
  });

  it('R-X11d control: an unknown key survives into the stored round and into the copy this instance serves', () => {
    assert.deepEqual(stored['x11d-ahead-1']?.futureField, { kept: 'as sent' }, 'adoption dropped a key it does not declare (a stripping schema loses what a later release adds)');
    const sent = served.body.rounds.find(r => r.roundId === 'x11d-ahead-1');
    assert.ok(sent, `the served list does not carry the adopted round: ${served.body.rounds.map(r => r.roundId).join(', ')}`);
    assert.deepEqual(sent.futureField, { kept: 'as sent' }, 'the served copy lost the unknown key: a strict or stripping schema breaks signatures and later fields');
  });
});
