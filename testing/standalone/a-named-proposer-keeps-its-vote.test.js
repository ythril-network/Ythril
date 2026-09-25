/**
 * Naming a member as a round's proposer does not drop that member's vote (`S-7`, the part published in 5.1.x).
 *
 * The subject of a round was left out of its voters on every round type. On a join or a removal the subject is the
 * member voted ON, so that is right; on every other round it is the PROPOSER, and a peer could name any member as
 * proposer and so drop that member's vote from the quorum on every third instance. The subject is now left out only
 * on join and remove; everywhere else the proposer is a voter, whose yes is cast (signed) when it opens the round.
 *
 * Run: node --test testing/standalone/a-named-proposer-keeps-its-vote.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const PEER = 'aaaaaaaa-0000-4000-8000-00000000beef';
const VICTIM = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER = 'aaaaaaaa-0000-4000-8000-00000000c0c0';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-named-proposer-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let concludeRoundIfReady;
before(async () => {
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  }), { mode: 0o600 });
  loader.loadConfig();
  ({ concludeRoundIfReady } = await import('../../server/dist/sync/governance.js'));
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const member = (instanceId) => ({ instanceId, label: instanceId.slice(-4), url: `http://${instanceId.slice(-4)}` });
const net = (type, members) => ({ id: 'n', type, spaces: ['general'], members: members.map(member), pendingRounds: [] });
const yes = (instanceId) => ({ instanceId, vote: 'yes', castAt: new Date().toISOString() });
const round = (over = {}) => ({
  roundId: 'r', type: 'space_deletion', spaceId: 'general', subjectInstanceId: PEER, subjectLabel: 'p', subjectUrl: '',
  deadline: future(), votes: [], ...over,
});

describe('naming a member as a round\'s proposer does not drop its vote', () => {
  const cases = [
    ['closed', [PEER, VICTIM], [yes(PEER), yes(SELF)]],
    ['braintree', [PEER, VICTIM], [yes(PEER), yes(SELF)]],
  ];
  for (const type of ['space_deletion', 'meta_change']) {
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
  it('closed: the proposer and every other member said yes', () => {
    const r = round({ subjectInstanceId: PEER, votes: [yes(PEER), yes(OTHER)] });
    concludeRoundIfReady(net('closed', [PEER, OTHER]), r);
    assert.equal(r.passed, true);
  });
  it('a join round is decided about its subject, who does not vote on it', () => {
    const r = round({ type: 'join', subjectInstanceId: VICTIM, votes: [yes(PEER), yes(SELF)] });
    concludeRoundIfReady(net('closed', [PEER]), r);
    assert.equal(r.passed, true);
  });
});
