/**
 * What a concluded round DOES here is written once — `applyRoundConclusion` — and every place that concludes a round calls it.
 *
 * ## The defect this holds
 *
 * A round concludes in three places — an operator's own cast (`networks/vote-acts.ts`), a peer's relayed cast
 * (`api/sync/votes.ts`) and the gossip pass (`sync/engine.ts`) — and each wrote out the same three steps: admit or introduce a
 * passed join, apply a passed space round, tell an ejected member. `apply-wipe-round.ts` said so in its own docblock ("one
 * function, three callers, on purpose") and still left two of the steps written three times. The expiry job is a FOURTH place a
 * round concludes, and a fourth copy is how a conclusion by the clock would have skipped a step a conclusion by a vote takes.
 *
 * ## What it holds
 *
 * - every `concludeRoundIfReady(` call in `server/src`, DERIVED, is in a file that calls `applyRoundConclusion` in the SAME
 *   function — or is one of the named opening sites, which admit or apply their own round the instant they open it (each row
 *   is held: it must still contain a call);
 * - `applyRoundConclusion(net, cfg, rounds, via)` does what the three copies did, for the rounds it is handed and no others.
 *
 * Run: node --test testing/standalone/a-round-conclusion-is-applied-by-one-function.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { enclosingBlockMatching } from './_structural-window.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, startFakePeer, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';

const DEFINITION = 'server/src/sync/governance.ts';

/** Sites that conclude a round at the moment they OPEN it: each admits, removes or applies it itself, in the same request. */
const OPENERS = {
  'server/src/spaces/meta-update.ts': 'opens a meta_change round and, when its own yes carries it, applies the change in the same request',
  'server/src/networks/network-acts.ts': 'opens a space_addition round and adds the space itself when the proposer\'s yes carries it',
  'server/src/networks/member-acts.ts': 'opens a join or remove round and admits or removes the member itself when the proposer\'s yes carries it',
  'server/src/api/invite.ts': 'opens the join round of an invite and admits the joiner itself when the inviter\'s yes carries it',
};

/** `async (req, res) => {`, `function name(…) {`, and the `): Promise<…> {` that closes a multi-line signature — not `if (…) {`. */
const FUNCTION_LIKE = /=>\s*\{$|\bfunction\b[^\n]*\{$|^\s*\)\s*(?::[^{]*)?\{$/;

describe('every site that concludes a round applies its conclusion', () => {
  const files = trackedSources('server/src', { untracked: true, floor: 100 });
  const sites = [];
  for (const file of files) {
    if (file === DEFINITION) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/(?<![.\w$])concludeRoundIfReady\s*\(/g)) {
      const fn = enclosingBlockMatching(src, m.index, FUNCTION_LIKE, `the function around the call in ${file}`);
      sites.push({ file, at: m.index, fn, applies: fn !== null && /\bapplyRoundConclusion\s*\(/.test(fn.slice(fn.indexOf('concludeRoundIfReady'))) });
    }
  }

  it('finds the sites (the floor): the operator cast, the relay, gossip and the openers', () => {
    const where = new Set(sites.map(s => s.file));
    for (const f of ['server/src/networks/vote-acts.ts', 'server/src/api/sync/votes.ts', 'server/src/sync/engine.ts']) {
      assert.ok(where.has(f), `${f} no longer calls concludeRoundIfReady — re-point this gate (a conclusion moved somewhere it cannot see)`);
    }
    assert.ok(sites.length >= 8, `only ${sites.length} call site(s) found`);
  });

  it('each one that is not an opener calls applyRoundConclusion after concluding, in the same function', () => {
    const bare = sites.filter(s => !(s.file in OPENERS) && !s.applies).map(s => s.file);
    assert.deepEqual([...new Set(bare)], [],
      'these conclude a round and do not apply what it decided — a passed join never admits, a space round never lands. '
      + 'Call applyRoundConclusion(net, cfg, rounds, via) after concludeRoundIfReady, or, if the site opens the round and applies it itself, name it in OPENERS with the reason.');
  });

  it('the expiry job is one of them (it is the fourth place a round concludes)', () => {
    const job = sites.find(s => s.file === 'server/src/networks/round-expiry.ts');
    assert.ok(job, 'networks/round-expiry.ts does not conclude a round through concludeRoundIfReady');
    assert.ok(job.applies, 'the expiry job concludes rounds and does not apply what it concluded');
  });

  it('every opener row still contains a call (a row cannot outlive its code)', () => {
    const stale = Object.keys(OPENERS).filter(f => !sites.some(s => s.file === f));
    assert.deepEqual(stale, [], `these rows excuse a call that is gone: ${stale.join(', ')}`);
  });

  it('the three written-out copies are gone: no site but the function calls applyConcludedSpaceRounds or applyPassedJoin', () => {
    const offenders = [];
    for (const file of files) {
      if (['server/src/networks/round-conclusion.ts', 'server/src/spaces/apply-wipe-round.ts', 'server/src/networks/member-introductions.ts'].includes(file)) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      if (/(?<![.\w$])(?:applyConcludedSpaceRounds|applyPassedJoin)\s*\(/.test(src.replace(/import\s*\{[^}]*\}\s*from[^;]*;/g, ''))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'these still apply a conclusion step by step, which is the copy the one function replaces');
  });
});

describe('applyRoundConclusion does what the three copies did', { skip: privateAddressSkipReason() }, () => {
  const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
  const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
  const dir = tempInstanceDir('ythril-apply-conclusion-');
  let peer;
  before(async () => { allowEngineToDialPrivatePeers(); peer = await startFakePeer((method, url) => (url === '/api/notify' ? { status: 204, body: undefined } : undefined)); });
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  const member = (instanceId, extra = {}) => ({ instanceId, label: instanceId.slice(-2), url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
  const base = (over = {}) => ({
    roundId: 'r', type: 'join', subjectInstanceId: JOINER, subjectLabel: 'Joiner', subjectUrl: '', openedAt: '2026-10-09T10:00:00.000Z',
    deadline: '2026-10-10T10:00:00.000Z', votes: [{ instanceId: P1, vote: 'yes', castAt: '2026-10-09T10:01:00.000Z' }],
    concluded: true, passed: true, ...over,
  });
  const boot = (rounds, extra = {}) => bootInstance(dir, {
    instanceId: SELF, spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }],
    peerTokens: { [P1]: 'tok' },
    networks: [{ id: 'n', label: 'N', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], members: [member(P1)], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: rounds, ...extra }],
  });
  const apply = async (loader, rounds, via = 'test') => {
    const { applyRoundConclusion } = await import('../../server/dist/networks/round-conclusion.js');
    const cfg = loader.getConfig();
    applyRoundConclusion(cfg.networks[0], cfg, rounds, via);
    return cfg.networks[0];
  };

  it('a passed join is admitted from its pending member', async () => {
    const r = base({ pendingMember: member(JOINER) });
    const loader = await boot([r]);
    const net = await apply(loader, [r]);
    assert.ok(net.members.some(m => m.instanceId === JOINER), 'the passed join was not admitted');
  });

  it('a passed space_deletion is marked applied, once', async () => {
    const r = base({ type: 'space_deletion', spaceId: 'notes', subjectInstanceId: P1 });
    const loader = await boot([r]);
    await apply(loader, [r]);
    assert.equal(r.appliedHere, true);
  });

  it('a passed remove round tells the ejected member', async () => {
    const r = base({ type: 'remove', subjectInstanceId: P1, subjectUrl: peer.url });
    const loader = await boot([r], { members: [member(P1)] });
    loader.getSecrets().peerTokens[P1] = 'tok';
    peer.seen.length = 0;
    await apply(loader, [r]);
    await settled(() => peer.seen.length);
    const notice = peer.seen.find(s => s.method === 'POST' && s.url === '/api/notify');
    assert.ok(notice, 'the ejected member was not told');
    assert.equal(JSON.parse(notice.body).event, 'member_removed');
  });

  it('a round that did not pass does nothing, and only the rounds it is handed are looked at', async () => {
    const failed = base({ roundId: 'failed', passed: false, pendingMember: member(JOINER) });
    const other = base({ roundId: 'other', subjectInstanceId: 'zzzz', pendingMember: member('zzzz') });
    const loader = await boot([failed, other]);
    const net = await apply(loader, [failed]);
    assert.ok(!net.members.some(m => m.instanceId === JOINER), 'a join that failed was admitted');
    assert.ok(!net.members.some(m => m.instanceId === 'zzzz'), 'a round it was not handed was applied');
  });
});
