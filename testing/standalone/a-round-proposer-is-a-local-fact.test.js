/**
 * "This instance proposed it" is a fact THIS instance records, never a field a peer can set (`S-7`).
 *
 * A round adopted by gossip kept every field it arrived with, and three decisions read `subjectInstanceId === self` as
 * "I proposed this": a passed `space_addition` skipped the guard that keeps a same-named private space out of the
 * network, and a passed `meta_change` wrote the proposer's OWN definitions instead of the network's layer. So a peer
 * serving a round with `subjectInstanceId: <victim>` made the victim treat it as its own. And on a THIRD member the
 * subject is dropped from the voters, so naming the victim dropped the victim's vote from the quorum there.
 *
 * What holds now:
 * - `proposedHere` is set only by opening a round here (`openRoundHere`), and stripped from every round adopted from
 *   or served to a peer, alongside `appliedHere` (S-9) — one module owns this instance's round state.
 * - The subject is left out of the voters only on join and remove, where it is the member voted ON. On every other
 *   round it is the proposer, a voter like any member, whose yes is cast for it when the round opens (owner,
 *   2026-09-25: "of course a proposer votes yes ... require the yes but set it automatically"). A forged subject never
 *   voted: an unsigned cast is taken only from the voter itself.
 * - Nothing outside that module pushes onto `pendingRounds`, so a new opening site cannot forget the flag.
 *
 * Run: node --test testing/standalone/a-round-proposer-is-a-local-fact.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const PEER = 'aaaaaaaa-0000-4000-8000-00000000beef';
const VICTIM = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER = 'aaaaaaaa-0000-4000-8000-00000000c0c0';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-round-proposer-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let spaceAdditionTarget, concludeRoundIfReady, localState;
before(async () => {
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  }), { mode: 0o600 });
  loader.loadConfig();
  ({ spaceAdditionTarget } = await import('../../server/dist/networks/network-spaces.js'));
  ({ concludeRoundIfReady } = await import('../../server/dist/sync/governance.js'));
  // Imported where used rather than here, so a missing module fails ITS tests and not every test in the file.
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const member = (instanceId) => ({ instanceId, label: instanceId.slice(-4), url: `http://${instanceId.slice(-4)}` });
const net = (type, members, over = {}) => ({ id: 'n', type, spaces: ['general'], members: members.map(member), pendingRounds: [], ...over });
const yes = (instanceId) => ({ instanceId, vote: 'yes', castAt: new Date().toISOString() });
const round = (over = {}) => ({
  roundId: 'r', type: 'space_deletion', spaceId: 'general', subjectInstanceId: PEER, subjectLabel: 'p', subjectUrl: '',
  deadline: future(), votes: [], ...over,
});

describe('a passed space_addition: the proposer is who opened it HERE', () => {
  const addition = (over) => ({ spaceId: 'notes', subjectInstanceId: SELF, votes: [yes(PEER)], ...over });
  it('a round naming this instance as subject, adopted from a peer, still meets the private-space guard', () => {
    const r = spaceAdditionTarget(net('club', [PEER], { spaces: ['a'] }), addition(), SELF, ['a', 'notes']);
    assert.ok(r && 'skip' in r, `a peer named this instance as proposer and joined its private space: ${JSON.stringify(r)}`);
  });
  it('a round this instance opened carries its own space', () => {
    const r = spaceAdditionTarget(net('club', [PEER], { spaces: ['a'] }), addition({ proposedHere: true }), SELF, ['a', 'notes']);
    assert.deepEqual(r, { localId: 'notes' });
  });
});

describe('naming a member as a round\'s proposer does not drop its vote', () => {
  // On a round other than join or remove the proposer is a voter like any member: its yes is required, and it is cast
  // for it when the round opens. So a peer naming the victim as proposer leaves the victim's vote required.
  // Each: the network type, the members THIS instance sees, and casts that passed while the subject was dropped.
  const cases = [
    ['closed', [PEER, VICTIM], [yes(PEER), yes(SELF)]],
    ['braintree', [PEER, VICTIM], [yes(PEER), yes(SELF)]],
  ];
  for (const type of ['space_deletion', 'space_wipe', 'meta_change', 'space_addition']) {
    for (const [netType, members, votes] of cases) {
      it(`${type} on ${netType}: a named proposer that never voted does not pass it`, () => {
        const r = round({ type, subjectInstanceId: VICTIM, votes: [...votes] });
        concludeRoundIfReady(net(netType, members), r);
        assert.notEqual(r.passed, true, `a round naming ${VICTIM} as proposer passed without its vote`);
      });
    }
  }
});

describe('an honest proposal still passes', () => {
  it('two members: the proposer\'s automatic yes is the vote the other member waits for', () => {
    const r = round({ subjectInstanceId: PEER, votes: [yes(PEER)] });
    concludeRoundIfReady(net('closed', [PEER]), r);
    assert.equal(r.passed, true);
  });
  it('a proposal whose proposer\'s yes is missing does not pass', () => {
    const r = round({ subjectInstanceId: PEER, votes: [yes(OTHER)] });
    concludeRoundIfReady(net('closed', [PEER, OTHER]), r);
    assert.notEqual(r.passed, true);
  });
  it('closed: the proposer and every other member said yes', () => {
    const r = round({ subjectInstanceId: PEER, votes: [yes(PEER), yes(OTHER)] });
    concludeRoundIfReady(net('closed', [PEER, OTHER]), r);
    assert.equal(r.passed, true);
  });
  it('democratic: the proposer and a majority said yes', () => {
    const r = round({ subjectInstanceId: PEER, votes: [yes(PEER), yes(OTHER)] });
    concludeRoundIfReady(net('democratic', [PEER, OTHER, VICTIM]), r);
    assert.equal(r.passed, true);
  });
  it('a join round is decided about its subject, who does not vote on it', () => {
    const r = round({ type: 'join', subjectInstanceId: VICTIM, votes: [yes(PEER), yes(SELF)] });
    concludeRoundIfReady(net('closed', [PEER]), r);
    assert.equal(r.passed, true);
  });
});

describe('this instance\'s round state never crosses the wire', () => {
  before(async () => { localState = await import('../../server/dist/networks/round-local-state.js'); });
  it('a round opened here says so', () => {
    const n = net('closed', [PEER]);
    localState.openRoundHere(n, round({ subjectInstanceId: SELF }));
    assert.equal(n.pendingRounds.length, 1);
    assert.equal(n.pendingRounds[0].proposedHere, true);
  });
  it('a round adopted from a peer carries none of it, whatever the peer sent', () => {
    const n = net('closed', [PEER]);
    const adopted = localState.adoptPeerRound(n, round({ proposedHere: true, appliedHere: true, votes: [yes(PEER)], concluded: true }));
    assert.equal(n.pendingRounds[0], adopted);
    for (const f of localState.LOCAL_ROUND_FIELDS) assert.ok(!adopted[f], `${f} was taken from a peer`);
    assert.deepEqual(adopted.votes, [], 'casts are merged one by one, never adopted wholesale');
    assert.equal(adopted.concluded, false, 'a peer does not conclude a round here');
  });
  it('a round served to a peer carries none of it, and keeps what a peer needs', () => {
    const served = localState.roundForPeer(round({ proposedHere: true, appliedHere: true, votes: [yes(SELF)] }));
    for (const f of localState.LOCAL_ROUND_FIELDS) assert.ok(!(f in served), `${f} was served to a peer`);
    assert.equal(served.roundId, 'r');
    assert.deepEqual(served.votes, [yes(SELF)].map(v => ({ ...v, castAt: served.votes[0].castAt })));
  });
  it('names both local fields — a list that lost one would pass every loop above', () => {
    assert.deepEqual([...localState.LOCAL_ROUND_FIELDS].sort(), ['appliedHere', 'proposedHere']);
  });
});

describe('nothing outside that module adds a round', () => {
  const OWNER = 'server/src/networks/round-local-state.ts';
  it('every other source file leaves pendingRounds.push to it', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'));
    const pushers = files.filter(f => f !== OWNER && /pendingRounds\s*\.\s*push\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8'))));
    assert.deepEqual(pushers, [], `these add a round without recording whose it is: ${pushers.join(', ')}`);
  });
  it('the owner exists and is where the push lives', () => {
    assert.match(stripComments(fs.readFileSync(OWNER, 'utf8')), /pendingRounds\s*\.\s*push\s*\(/);
  });
});
