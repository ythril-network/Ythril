/**
 * A round that ends records HOW it ended, on this instance only, and the record is bounded.
 *
 * ## What it holds
 *
 * - `concludeRoundIfReady(net, round, now)` reads ONE `now` (the request's) for the deadline, and sets the LOCAL
 *   `outcome` (`passed` | `vetoed` | `expired`) and `concludedAt`. A veto beats expiry: a cast's `castAt` is unsigned and a
 *   relayer can set it, so it decides no label. At the deadline instant itself a round is still open.
 * - `outcome` and `concludedAt` are this instance's reading, never the network's: stripped from a round adopted from a peer
 *   and from one served to a peer, and classified LOCAL in the `VoteRound` interface itself (a field documented as LOCAL
 *   is in `LOCAL_ROUND_FIELDS` and the reverse — derived from the interface, not listed here).
 * - `roundElectorate(net, round)` is the ONE count of who may vote and how they voted; the log and the conclusion read it.
 * - `recordRoundOutcome(net, round, now)` is total (it never throws once a round has concluded), inserts a round once,
 *   clamps what a peer wrote, keeps the newest `ROUND_OUTCOMES_KEPT`, and orders a legacy entry (concluded before this
 *   version, outcome `ended`, no `concludedAt`) after every dated one. `outcomesFor(net, limit)` answers
 *   `{ outcomes, total }` newest first so a short page is distinguishable from a short log.
 * - pruning a concluded round records it first, so the prune loses nothing the operator can read.
 *
 * Run: node --test testing/standalone/a-round-records-how-it-ended.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bodyOf } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const P3 = 'aaaaaaaa-0000-4000-8000-0000000000a3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-round-ended-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

before(async () => {
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  }), { mode: 0o600 });
  loader.loadConfig();
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const member = (instanceId) => ({ instanceId, label: instanceId.slice(-2), url: `http://${instanceId.slice(-2)}` });
const net = (type, members, over = {}) => ({
  id: 'n', label: 'N', type, spaces: ['general'], members: members.map(member), pendingRounds: [], votingDeadlineHours: 24, ...over,
});
const cast = (instanceId, vote = 'yes', castAt = iso(NOW - 120_000)) => ({ instanceId, vote, castAt });
const round = (over = {}) => ({
  roundId: 'r1', type: 'space_deletion', spaceId: 'general', subjectInstanceId: P1, subjectLabel: 'Proposer', subjectUrl: '',
  openedAt: iso(NOW - 3_600_000), deadline: iso(NOW + 3_600_000), votes: [], concluded: false, ...over,
});
const governance = () => import('../../server/dist/sync/governance.js');
const outcomes = () => import('../../server/dist/networks/round-outcomes.js');

describe('how a round ended, read at ONE now', () => {
  it('a round every voter said yes to passed', async () => {
    const { concludeRoundIfReady } = await governance();
    const r = round({ votes: [cast(P1), cast(SELF)] });
    concludeRoundIfReady(net('closed', [P1]), r, NOW);
    assert.equal(r.concluded, true);
    assert.equal(r.passed, true);
    assert.equal(r.outcome, 'passed');
    assert.equal(r.concludedAt, iso(NOW), 'concludedAt is the `now` the request read, not a second clock');
  });

  it('a veto ended it vetoed', async () => {
    const { concludeRoundIfReady } = await governance();
    const r = round({ votes: [cast(P1), cast(SELF, 'veto')] });
    concludeRoundIfReady(net('closed', [P1]), r, NOW);
    assert.equal(r.concluded, true);
    assert.equal(r.passed, false);
    assert.equal(r.outcome, 'vetoed');
    assert.equal(r.concludedAt, iso(NOW));
  });

  it('a round past its deadline with no veto expired — judged against the `now` given, not the clock', async () => {
    const { concludeRoundIfReady } = await governance();
    // The deadline is in the REAL future: only the given `now` puts it behind us.
    const r = round({ deadline: iso(Date.now() + 3_600_000), votes: [cast(P1)] });
    concludeRoundIfReady(net('closed', [P1]), r, Date.now() + 7_200_000);
    assert.equal(r.concluded, true, 'the deadline was compared against the real clock, not the `now` the request read');
    assert.equal(r.outcome, 'expired');
    assert.equal(r.passed, false);
  });

  it('a veto beats expiry, whatever castAt says (castAt is unsigned and a relayer sets it)', async () => {
    const { concludeRoundIfReady } = await governance();
    for (const castAt of [iso(NOW - 7_200_000), iso(NOW + 7_200_000), 'garbage']) {
      const r = round({ deadline: iso(NOW - 60_000), votes: [cast(P1, 'veto', castAt)] });
      concludeRoundIfReady(net('closed', [P1]), r, NOW);
      assert.equal(r.outcome, 'vetoed', `a veto with castAt ${castAt} on an expired round was labelled ${r.outcome}`);
    }
  });

  it('at the deadline instant the round is still open, and a veto there still decides it', async () => {
    const { concludeRoundIfReady } = await governance();
    const open = round({ deadline: iso(NOW), votes: [cast(P1)] });
    concludeRoundIfReady(net('closed', [P1]), open, NOW);
    assert.notEqual(open.concluded, true, 'a round closed AT its deadline instant, a millisecond early');
    assert.equal(open.outcome, undefined);
    const vetoed = round({ deadline: iso(NOW), votes: [cast(P1, 'veto')] });
    concludeRoundIfReady(net('closed', [P1]), vetoed, NOW);
    assert.equal(vetoed.outcome, 'vetoed');
    const after = round({ deadline: iso(NOW - 1), votes: [cast(P1)] });
    concludeRoundIfReady(net('closed', [P1]), after, NOW);
    assert.equal(after.outcome, 'expired');
  });

  it('an undatable deadline concludes the round expired (fail closed)', async () => {
    const { concludeRoundIfReady } = await governance();
    for (const deadline of ['', 'soon', undefined]) {
      const r = round({ deadline, votes: [cast(P1)] });
      concludeRoundIfReady(net('closed', [P1]), r, NOW);
      assert.equal(r.outcome, 'expired', `a round with deadline ${JSON.stringify(deadline)} stayed open`);
    }
  });

  it('a round still undecided carries no outcome and no concludedAt', async () => {
    const { concludeRoundIfReady } = await governance();
    const r = round({ votes: [cast(P1)] });
    concludeRoundIfReady(net('closed', [P1]), r, NOW);
    assert.notEqual(r.concluded, true);
    assert.ok(!('outcome' in r) && !('concludedAt' in r));
  });
});

describe('the outcome is this instance\'s own reading — it never crosses the wire', () => {
  const localState = () => import('../../server/dist/networks/round-local-state.js');
  const carried = { outcome: 'passed', concludedAt: iso(NOW) };

  it('a round adopted from a peer carries neither, whatever the peer sent', async () => {
    const { adoptPeerRound } = await localState();
    const n = net('closed', [P1]);
    const adopted = adoptPeerRound(n, round({ ...carried }));
    assert.ok(!('outcome' in adopted) && !('concludedAt' in adopted), `a peer set ${JSON.stringify({ outcome: adopted.outcome, concludedAt: adopted.concludedAt })} on this instance's round`);
  });

  it('a round served to a peer carries neither', async () => {
    const { roundForPeer } = await localState();
    const served = roundForPeer(round({ ...carried, concluded: true, passed: true }));
    assert.ok(!('outcome' in served) && !('concludedAt' in served), 'this instance\'s reading of how a round ended was served to a peer');
  });

  it('names both in LOCAL_ROUND_FIELDS, with the two that were there', async () => {
    const { LOCAL_ROUND_FIELDS } = await localState();
    for (const f of ['appliedHere', 'proposedHere', 'outcome', 'concludedAt']) assert.ok(LOCAL_ROUND_FIELDS.includes(f), `${f} is not a local round field`);
  });

  it('every VoteRound key the interface documents as LOCAL is a local field, and the reverse (derived from the interface)', async () => {
    const { LOCAL_ROUND_FIELDS } = await localState();
    const src = fs.readFileSync('server/src/config/types-networks.ts', 'utf8');
    const iface = bodyOf(src, 'VoteRound', 'the VoteRound interface');
    // A key is `  name?: type;` at two-space indent; its doc comment is the block immediately above it.
    const keys = [...iface.matchAll(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?^ {2}([A-Za-z]\w*)\??\s*:/gm)]
      .map(m => ({ key: m[2], doc: m[1] ?? '' }));
    assert.ok(keys.length >= 20, `only ${keys.length} keys read out of the interface — the derivation is broken`);
    const documentedLocal = keys.filter(k => /^\/\*\*\s*\*?\s*LOCAL\b/.test(k.doc)).map(k => k.key).sort();
    assert.deepEqual(documentedLocal, [...LOCAL_ROUND_FIELDS].sort(),
      'a VoteRound field documented as LOCAL must be in LOCAL_ROUND_FIELDS (so it never crosses the wire), and a local field must say so in the interface');
  });
});

describe('roundElectorate: who may vote, and how they voted', () => {
  const electorate = async (n, r) => (await governance()).roundElectorate(n, r);

  it('on a closed network it is every member and this instance', async () => {
    const e = await electorate(net('closed', [P1, P2]), round({ subjectInstanceId: P1, votes: [cast(P1), cast(P2), cast(SELF, 'veto')] }));
    assert.deepEqual(e, { eligible: 3, yes: 2, veto: 1 });
  });
  it('a join or removal leaves its subject out', async () => {
    for (const type of ['join', 'remove']) {
      const e = await electorate(net('democratic', [P1, P2]), round({ type, subjectInstanceId: P2, votes: [cast(P1), cast(P2), cast(SELF)] }));
      assert.deepEqual(e, { eligible: 2, yes: 2, veto: 0 }, `${type}: the member voted ON was counted as an elector`);
    }
  });
  it('when this instance is the subject of a join it is not asked either', async () => {
    const e = await electorate(net('democratic', [P1, P2]), round({ type: 'join', subjectInstanceId: SELF, votes: [cast(P1), cast(SELF)] }));
    assert.deepEqual(e, { eligible: 2, yes: 1, veto: 0 });
  });
  it('a cast by someone who is not a member counts for nothing', async () => {
    const e = await electorate(net('democratic', [P1]), round({ votes: [cast(P3), cast(P3, 'veto'), cast(P1)] }));
    assert.deepEqual(e, { eligible: 2, yes: 1, veto: 0 });
  });
  it('agrees with what concludeRoundIfReady decided: a round passes on a democratic majority exactly when yes > eligible / 2', async () => {
    const { concludeRoundIfReady } = await governance();
    for (const voters of [[], [P1], [P1, P2], [P1, P2, P3]]) {
      const n = net('democratic', [P1, P2, P3]);
      const r = round({ subjectInstanceId: P1, votes: [...voters.map(v => cast(v)), cast(SELF)] });
      const e = await electorate(n, { ...r, votes: [...r.votes] });
      concludeRoundIfReady(n, r, NOW);
      assert.equal(r.passed === true, e.yes > e.eligible / 2, `electorate ${JSON.stringify(e)} and the decision disagree (passed ${r.passed})`);
    }
  });
});

describe('recordRoundOutcome', () => {
  const concluded = (over = {}) => round({ concluded: true, passed: false, outcome: 'expired', concludedAt: iso(NOW), votes: [cast(P1)], ...over });

  it('records what the operator needs to read, from this instance\'s side', async () => {
    const { recordRoundOutcome } = await outcomes();
    const n = net('closed', [P1], { spaces: ['mine'], spaceMap: { notes: 'mine' } });
    const r = concluded({ type: 'space_wipe', spaceId: 'notes', subjectLabel: 'Peer One' });
    recordRoundOutcome(n, r, NOW);
    assert.equal(n.roundOutcomes.length, 1);
    const e = n.roundOutcomes[0];
    assert.equal(e.roundId, 'r1');
    assert.equal(e.type, 'space_wipe');
    assert.equal(e.space, 'mine', 'the entry names the space as THIS instance calls it, not as the proposer did');
    assert.equal(e.subjectLabel, 'Peer One');
    assert.equal(e.openedAt, r.openedAt);
    assert.equal(e.deadline, r.deadline);
    assert.equal(e.concludedAt, iso(NOW));
    assert.equal(e.outcome, 'expired');
    assert.deepEqual([e.yes, e.veto, e.eligible], [1, 0, 2]);
  });

  it('keeps no member credential, cast or proposal body in the log (a joiner\'s poll may keep the invite-key hash it needs; the door never shows it)', async () => {
    const { recordRoundOutcome } = await outcomes();
    const n = net('closed', [P1]);
    recordRoundOutcome(n, concluded({
      type: 'join', inviteKeyHash: 'bcrypt-hash', pendingMember: { instanceId: P2, label: 'x', url: 'http://x', tokenHash: 'th' },
      pendingMeta: { purpose: 'p' }, requiredVoters: [P1],
    }), NOW);
    const text = JSON.stringify(n.roundOutcomes[0]);
    for (const leak of ['tokenHash', 'pendingMember', 'pendingMeta', '"votes"', 'requiredVoters', 'castAt']) {
      assert.ok(!text.includes(leak), `the outcome entry carries ${leak}: ${text}`);
    }
    assert.ok(!('proposer' in n.roundOutcomes[0]), 'a VoteRound has no proposer, so the entry must not invent one');
  });

  it('is total: a missing log, missing votes or non-text labels never throw once a round has concluded', async () => {
    const { recordRoundOutcome } = await outcomes();
    for (const odd of [{ votes: undefined }, { votes: null }, { subjectLabel: undefined }, { subjectLabel: 42 }, { openedAt: undefined }, { spaceId: undefined }]) {
      const n = net('closed', [P1]);
      assert.equal(n.roundOutcomes, undefined);
      assert.doesNotThrow(() => recordRoundOutcome(n, concluded(odd), NOW), `threw for ${JSON.stringify(odd)}`);
      assert.equal(n.roundOutcomes.length, 1, `nothing was recorded for ${JSON.stringify(odd)}`);
    }
  });

  it('clamps and cleans what a peer wrote: labels at 200 characters, a summary at 800, control characters out', async () => {
    const { recordRoundOutcome } = await outcomes();
    const n = net('closed', [P1]);
    const r = concluded({
      type: 'meta_change', subjectLabel: `peer\u0000\u0007\u001b[31m${'L'.repeat(1000)}`,
      metaChangedFields: ['purpose'], changedTypes: [`fact:${'T'.repeat(5000)}\u0000\u0007`], keptTypes: [],
    });
    recordRoundOutcome(n, r, NOW);
    const e = n.roundOutcomes[0];
    assert.ok(e.subjectLabel.length <= 200, `subjectLabel is ${e.subjectLabel.length} characters`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(e.subjectLabel), 'a control character survived in subjectLabel');
    assert.equal(typeof e.summary, 'string', 'a meta_change round records its proposed summary');
    assert.ok(e.summary.length <= 800, `summary is ${e.summary.length} characters`);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(e.summary), 'a control character survived in summary');
  });

  it('inserts a round once: the second call for the same id changes nothing', async () => {
    const { recordRoundOutcome } = await outcomes();
    const n = net('closed', [P1]);
    recordRoundOutcome(n, concluded({ outcome: 'expired' }), NOW);
    recordRoundOutcome(n, concluded({ outcome: 'vetoed', concludedAt: iso(NOW + 1000) }), NOW + 1000);
    assert.equal(n.roundOutcomes.length, 1);
    assert.equal(n.roundOutcomes[0].outcome, 'expired', 'the later call overwrote the first reading');
  });

  it('keeps the newest ROUND_OUTCOMES_KEPT by concludedAt: 50 stay, the 51st evicts the oldest', async () => {
    const { recordRoundOutcome, ROUND_OUTCOMES_KEPT } = await outcomes();
    assert.equal(ROUND_OUTCOMES_KEPT, 50);
    const n = net('closed', [P1]);
    for (let i = 0; i < ROUND_OUTCOMES_KEPT; i++) recordRoundOutcome(n, concluded({ roundId: `r${i}`, concludedAt: iso(NOW + i * 1000) }), NOW + i * 1000);
    assert.equal(n.roundOutcomes.length, 50);
    recordRoundOutcome(n, concluded({ roundId: 'r50', concludedAt: iso(NOW + 50_000) }), NOW + 50_000);
    const ids = n.roundOutcomes.map(e => e.roundId);
    assert.equal(ids.length, 50);
    assert.ok(!ids.includes('r0'), 'the OLDEST entry survived');
    assert.ok(ids.includes('r50') && ids.includes('r1'));
  });

  it('a round older than everything kept is the one that does not stay (newest by concludedAt, not by arrival)', async () => {
    const { recordRoundOutcome, ROUND_OUTCOMES_KEPT } = await outcomes();
    const n = net('closed', [P1]);
    for (let i = 0; i < ROUND_OUTCOMES_KEPT; i++) recordRoundOutcome(n, concluded({ roundId: `r${i}`, concludedAt: iso(NOW + (i + 10) * 1000) }), NOW);
    recordRoundOutcome(n, concluded({ roundId: 'old', concludedAt: iso(NOW - 86_400_000) }), NOW);
    assert.ok(!n.roundOutcomes.some(e => e.roundId === 'old'), 'an old round pushed a newer one out');
    assert.equal(n.roundOutcomes.length, 50);
  });

  it('a legacy round (concluded before this version) is recorded as ended, undated, and ordered after every dated one', async () => {
    const { recordRoundOutcome, outcomesFor } = await outcomes();
    const n = net('closed', [P1]);
    const legacy = concluded({ roundId: 'legacy' }); delete legacy.outcome; delete legacy.concludedAt;
    recordRoundOutcome(n, legacy, NOW);
    recordRoundOutcome(n, concluded({ roundId: 'dated-old', concludedAt: iso(NOW - 86_400_000) }), NOW);
    recordRoundOutcome(n, concluded({ roundId: 'dated-new', concludedAt: iso(NOW) }), NOW);
    const { outcomes: list, total } = outcomesFor(n, 10);
    assert.equal(total, 3);
    assert.deepEqual(list.map(e => e.roundId), ['dated-new', 'dated-old', 'legacy']);
    const e = list[2];
    assert.equal(e.outcome, 'ended', 'a round whose reason was never recorded is not guessed at');
    assert.ok(!e.concludedAt, 'a legacy entry has no date to show');
  });

  it('outcomesFor answers { outcomes, total } newest first, and `total` is the whole log', async () => {
    const { recordRoundOutcome, outcomesFor } = await outcomes();
    const n = net('closed', [P1]);
    assert.deepEqual(outcomesFor(n, 20), { outcomes: [], total: 0 }, 'a network with no log answers empty, not an error');
    for (let i = 0; i < 5; i++) recordRoundOutcome(n, concluded({ roundId: `r${i}`, concludedAt: iso(NOW + i * 1000) }), NOW);
    const page = outcomesFor(n, 2);
    assert.deepEqual(page.outcomes.map(e => e.roundId), ['r4', 'r3']);
    assert.equal(page.total, 5);
  });
});

describe('pruning a concluded round loses nothing the operator can read', () => {
  const retention = () => import('../../server/dist/sync/vote-round-retention.js');

  it('a concluded round past its deadline is removed AND recorded once', async () => {
    const { pruneExpiredRounds } = await retention();
    const n = net('closed', [P1]);
    n.pendingRounds = [
      round({ roundId: 'legacy', concluded: true, passed: false, deadline: iso(NOW - 3_600_000) }),
      round({ roundId: 'new-style', concluded: true, passed: false, outcome: 'vetoed', concludedAt: iso(NOW - 60_000), deadline: iso(NOW - 3_600_000) }),
      round({ roundId: 'still-open', deadline: iso(NOW + 3_600_000) }),
    ];
    assert.equal(pruneExpiredRounds(n, NOW), 2);
    assert.deepEqual(n.pendingRounds.map(r => r.roundId), ['still-open']);
    const byId = Object.fromEntries(n.roundOutcomes.map(e => [e.roundId, e]));
    assert.deepEqual(Object.keys(byId).sort(), ['legacy', 'new-style']);
    assert.equal(byId['legacy'].outcome, 'ended');
    assert.equal(byId['new-style'].outcome, 'vetoed');
  });

  it('a round already recorded when it concluded is not recorded twice', async () => {
    const { pruneExpiredRounds } = await retention();
    const { recordRoundOutcome } = await outcomes();
    const n = net('closed', [P1]);
    const r = round({ roundId: 'once', concluded: true, passed: false, outcome: 'expired', concludedAt: iso(NOW - 60_000), deadline: iso(NOW - 3_600_000) });
    n.pendingRounds = [r];
    recordRoundOutcome(n, r, NOW - 60_000);
    pruneExpiredRounds(n, NOW);
    assert.equal(n.roundOutcomes.filter(e => e.roundId === 'once').length, 1);
  });
});

describe('the writer of `outcome` is the conclusion, and nothing decides by reading it back', () => {
  it('concludeRoundIfReady assigns it (the floor: the derivation found a writer)', () => {
    const code = stripComments(fs.readFileSync('server/src/sync/governance.ts', 'utf8'));
    assert.match(code, /\.outcome\s*=[^=]/, 'no assignment of a round outcome in the conclusion');
    assert.match(code, /\.concludedAt\s*=[^=]/);
  });
});
