/**
 * A round is concluded and its conclusion applied in ONE step — `settleRounds` — and no other code concludes a round or applies a conclusion by hand
 * (design v5 section 1.1 and 6.2, gates (a) and (b)).
 *
 * ## The defect this holds, and what changed from its first form
 *
 * A round concluded in three places, each of which wrote out the same steps (admit a passed join, apply a passed space round, tell an ejected member);
 * the first form of this file held that each site called `applyRoundConclusion` "in the same function" and excused four OPENERS that concluded a round
 * at the moment they opened it and applied it by hand. Those four are the defect, not an exemption (Q-453: two of them never evaluated the round, and
 * each applied a conclusion its own way). The rule is now one sentence: **every conclusion of a round and every application of one is inside
 * `settleRounds`**, the one step the settle sites (the cast, the relay, the gossip pass, the expiry tick, the retry, the opener's proposer yes) call
 * with their `via`. The first form's `OPENERS` table is gone with the rule it contradicted.
 *
 * ## What it holds
 *
 * - **Source (derived, with a floor).** Each `concludeRoundIfReady(` call outside `sync/governance.ts` is inside `settleRounds` by name resolution (its
 *   outermost function), save the forecast, which evaluates a scratch copy and never applies (the exemption is stated and goes stale if the file stops
 *   calling it); each `applyRoundConclusion(` call is inside `settleRounds`; and `settleRounds` does both. `every-round-is-opened-and-settled-by-one-
 *   function.test.js` holds the same two gates beside the open path; this file keeps them next to the behaviour they are the consequence of.
 * - **The three written-out copies stay gone:** no file but the settle module, the space-round module and the introductions module calls
 *   `applyConcludedSpaceRounds` or `applyPassedJoin`.
 * - **Behaviour, through `settleRounds` itself:** a round that concludes as passed is applied, read on the LIVE config after the instance is quiescent
 *   (never on a local object); a passed removal tells the ejected member ONCE, and settling the same round again tells nobody (the twin of the first
 *   send); a round that did not pass does nothing; and only the rounds it is handed are looked at. A passed space deletion is applied by the runner, which
 *   needs the database: its cells, read live, are the settle matrix's (`a-round-conclusion-lands-the-same-at-every-site-db.test.js`).
 *
 * ## Written before the code (red on the base commit, 84f0b3cc)
 *
 * `settleRounds` does not exist: the source gates find `concludeRoundIfReady` in `networks/vote-acts.ts`, `api/sync/votes.ts`, `sync/engine.ts` and
 * `networks/round-expiry.ts`, and `applyRoundConclusion` in the same four, outside any `settleRounds`; the behaviour rows fail on the missing export.
 *
 * Run: node --test testing/standalone/a-round-conclusion-is-applied-by-one-function.test.js  (the behaviour rows need a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { callSitesOf } from './_call-sites.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, startFakePeer, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { quiescent } from './_quiescence.mjs';
import { requireExport } from './_round-open-fixtures.mjs';

const DEFINITION = 'server/src/sync/governance.ts';
/** The one file allowed to call `concludeRoundIfReady` outside the settle step, and why. It goes stale when the file stops calling it. */
const EXEMPT = { 'server/src/networks/round-forecast.ts': 'evaluates a scratch copy and never applies it (the `ownYesCarries` forecast)' };

describe('every conclusion of a round and every application of one is inside settleRounds', () => {
  const concludes = callSitesOf('concludeRoundIfReady').filter(c => c.file !== DEFINITION);
  const applies = callSitesOf('applyRoundConclusion');

  it('finds the sites (the floor): the settle step concludes and applies, and the call sites are not zero', () => {
    assert.ok(concludes.length >= 1, 'no concludeRoundIfReady call found outside sync/governance.ts: re-anchor this gate');
    assert.ok(applies.length >= 1, 'no applyRoundConclusion call found: re-anchor this gate');
    assert.ok(concludes.some(c => c.fn === 'settleRounds'), 'settleRounds does not conclude a round — design v5 section 1.1: the one settle step');
    assert.ok(applies.some(c => c.fn === 'settleRounds'), 'settleRounds does not apply what it concluded');
  });

  it('(a) each concludeRoundIfReady call is inside settleRounds, but the forecast\'s, which evaluates a scratch copy', () => {
    const stray = concludes.filter(c => c.fn !== 'settleRounds' && !(c.file in EXEMPT)).map(c => `${c.file} (${c.fn ?? 'module scope'})`);
    assert.deepEqual([...new Set(stray)], [],
      'these conclude a round outside the one settle step, so what they conclude is applied by hand, differently, or not at all (Q-453)');
  });

  it('(b) each applyRoundConclusion call is inside settleRounds', () => {
    const stray = applies.filter(c => c.fn !== 'settleRounds').map(c => `${c.file} (${c.fn ?? 'module scope'})`);
    assert.deepEqual([...new Set(stray)], [], 'these apply a conclusion outside the settle step');
  });

  it('an exemption cannot outlive its code (the forecast still calls concludeRoundIfReady, or its row is stale)', () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      assert.ok(concludes.some(c => c.file === file), `${file} is excused for "${why}" and no longer calls concludeRoundIfReady: delete the row`);
    }
  });

  it('the written-out copies stay gone: no file but the settle module, the space-round module and the introductions module applies a step by hand', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 100 });
    const offenders = [];
    for (const file of files) {
      if (['server/src/networks/round-conclusion.ts', 'server/src/spaces/apply-wipe-round.ts', 'server/src/networks/member-introductions.ts'].includes(file)) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      if (/(?<![.\w$])(?:applyConcludedSpaceRounds|applyPassedJoin)\s*\(/.test(src.replace(/import\s*\{[^}]*\}\s*from[^;]*;/g, ''))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'these still apply a conclusion step by step, which is the copy the one function replaces');
  });
});

describe('what settleRounds does for the rounds it is handed', { skip: privateAddressSkipReason() }, () => {
  const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
  const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
  const NOW = Date.parse('2026-10-09T10:30:00.000Z');
  const dir = tempInstanceDir('ythril-settle-applies-');
  let peer;
  before(async () => { allowEngineToDialPrivatePeers(); peer = await startFakePeer((method, url) => (url === '/api/notify' ? { status: 204, body: undefined } : undefined)); });
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  const member = (instanceId, extra = {}) => ({ instanceId, label: instanceId.slice(-2), url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
  const yes = (instanceId) => ({ instanceId, vote: 'yes', castAt: '2026-10-09T10:01:00.000Z' });
  /** A round one evaluation from concluded as passed: everyone who votes has voted yes, and nothing has concluded it yet. */
  const open = (over = {}) => ({
    roundId: 'r', type: 'join', subjectInstanceId: JOINER, subjectLabel: 'Joiner', subjectUrl: '', openedAt: '2026-10-09T10:00:00.000Z',
    deadline: '2026-10-10T10:00:00.000Z', votes: [yes(P1), yes(SELF)], concluded: false, ...over,
  });
  const boot = (rounds, extra = {}) => bootInstance(dir, {
    instanceId: SELF, spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }],
    peerTokens: { [P1]: 'tok' },
    networks: [{ id: 'n', label: 'N', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], members: [member(P1)], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: rounds, ...extra }],
  });
  /**
   * Settle the rounds named by `ids` through the one step — the objects the LIVE config holds, never the fixture's own, which the loader has copied —
   * then wait for quiescence and hand back the live network and what the step answered.
   */
  const settle = async (loader, ids, via = 'gossip') => {
    const settleRounds = await requireExport('../../server/dist/networks/round-conclusion.js', 'settleRounds', 'design v5 section 1.1: the one settle step');
    const cfg = loader.getConfig();
    const out = settleRounds(cfg.networks[0], cfg, ids.map(id => liveRound(cfg.networks[0], id)), via, NOW);
    await out.settled;
    await quiescent(loader);
    return { out, net: loader.getConfig().networks[0] };
  };
  const liveRound = (net, id) => net.pendingRounds.find(r => r.roundId === id);

  it('a round that concludes as passed is applied: a join admits its pending member, read from the live roster', async () => {
    const r = open({ pendingMember: member(JOINER) });
    const loader = await boot([r]);
    const { out, net } = await settle(loader, ['r']);
    assert.deepEqual(out.concluded.map(x => x.roundId), ['r'], 'the step did not report the round it concluded');
    assert.equal(out.wrote, true, 'the step changed the config and did not say so (the caller would not save)');
    assert.equal(liveRound(net, 'r').passed, true);
    assert.ok(net.members.some(m => m.instanceId === JOINER), 'the passed join was not admitted');
  });

  it('a passed removal tells the ejected member once, and settling the same round again tells nobody', async () => {
    const r = open({ type: 'remove', subjectInstanceId: P1, subjectUrl: peer.url, votes: [yes(SELF)] });
    const loader = await boot([r]);
    loader.getSecrets().peerTokens[P1] = 'tok';
    peer.seen.length = 0;
    const first = await settle(loader, ['r']);
    const notices = () => peer.seen.filter(s => s.method === 'POST' && s.url === '/api/notify' && /member_removed/.test(s.body));
    assert.equal(notices().length, 1, 'the ejected member was not told exactly once');
    assert.deepEqual(first.out.concluded.map(x => x.roundId), ['r']);
    const again = await settle(loader, ['r']);
    assert.deepEqual(again.out.concluded.map(x => x.roundId), [], 'a round that had already concluded was reported as concluded again');
    assert.equal(notices().length, 1, 'settling a concluded removal announced it again: every held removal would be re-sent on every pass');
  });

  it('a round that did not pass does nothing, and only the rounds it is handed are looked at', async () => {
    const vetoed = open({ roundId: 'vetoed', pendingMember: member(JOINER), votes: [{ instanceId: P1, vote: 'veto', castAt: '2026-10-09T10:01:00.000Z' }, yes(SELF)] });
    const other = open({ roundId: 'other', subjectInstanceId: 'zzzz', pendingMember: member('zzzz') });
    const loader = await boot([vetoed, other]);
    const { out, net } = await settle(loader, ['vetoed']);
    assert.deepEqual(out.concluded.map(x => x.roundId), ['vetoed'], 'the vetoed round concludes (as failed) and nothing else does');
    assert.equal(liveRound(net, 'vetoed').passed, false);
    assert.ok(!net.members.some(m => m.instanceId === JOINER), 'a join that failed was admitted');
    assert.equal(liveRound(net, 'other').concluded, false, 'a round the step was not handed was concluded');
    assert.ok(!net.members.some(m => m.instanceId === 'zzzz'), 'a round the step was not handed was applied');
  });
});
