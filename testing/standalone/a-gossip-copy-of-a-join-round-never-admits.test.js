/**
 * A member that learned a join round by GOSSIP never admits its subject on its own vote (`Q-154`, the credential half).
 *
 * On a closed or democratic network only the member holding the joiner's credentials may admit it: a round copy
 * that arrived by gossip carries `pendingMember` with its `tokenHash` stripped, and the gossip pass
 * (`sync/engine.ts`) admits only when `tokenHash` is present. `castVoteAct` — the operator's own vote — kept an admit
 * block of its own without that check, so a member that concluded a gossip-learned round by voting pushed a
 * credential-less member onto its roster. That member could never authenticate here, and nothing else would admit it
 * properly, because it was already "a member".
 *
 * A braintree is the other rule — only the direct parent admits — and is pinned here too so the guard does not
 * swallow it.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-gossip-copy-of-a-join-round-never-admits.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-gossip-join-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SELF = 'aaaa0000-0000-4000-8000-000000000001';
const PEER = 'bbbb0000-0000-4000-8000-000000000002';
const JOINER = 'cccc0000-0000-4000-8000-000000000003';

const member = (instanceId, extra = {}) => ({
  instanceId, label: instanceId.slice(0, 4), url: `https://${instanceId.slice(0, 4)}.example`, tokenHash: '$2b$10$peer', direction: 'both', ...extra,
});

const joinRound = (roundId, pendingMember) => ({
  roundId, type: 'join', subjectInstanceId: JOINER, subjectLabel: 'cccc', subjectUrl: 'https://cccc.example',
  deadline: new Date(Date.now() + 3_600_000).toISOString(), openedAt: new Date().toISOString(),
  votes: [{ instanceId: PEER, vote: 'yes', castAt: new Date().toISOString() }],
  pendingMember,
});

let loader, votes;

function network(id, type, round) {
  return { id, label: id, type, spaces: [], members: [member(PEER)], pendingRounds: [round], votingDeadlineHours: 24 };
}

describe('a gossip copy of a join round never admits on a local vote', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: SELF, instanceLabel: 'self',
      spaces: [{ id: 'general', label: 'General' }],
      networks: [
        network('closed-gossip', 'closed', joinRound('r-closed-gossip', member(JOINER, { tokenHash: '' }))),
        network('closed-holder', 'closed', joinRound('r-closed-holder', member(JOINER))),
        network('demo-gossip', 'democratic', joinRound('r-demo-gossip', member(JOINER, { tokenHash: '' }))),
        network('tree-parent', 'braintree', joinRound('r-tree-parent', member(JOINER, { tokenHash: '', parentInstanceId: SELF }))),
      ],
      tokens: [],
    }, null, 2));
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    votes = await import('../../server/dist/networks/vote-acts.js');
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const cast = (netId, roundId) => {
    const r = votes.castVoteAct(netId, roundId, { vote: 'yes' });
    assert.equal(r.status, 200, `the vote was refused: ${JSON.stringify(r)}`);
    assert.equal(r.body.concluded, true, 'precondition: this vote concludes the round');
    return loader.getConfig().networks.find(n => n.id === netId).members.map(m => m.instanceId);
  };

  for (const id of ['closed-gossip', 'demo-gossip']) {
    it(`${id}: a passed round whose pending member carries no credential does not admit it`, () => {
      const members = cast(id, `r-${id}`);
      assert.ok(!members.includes(JOINER),
        'this member holds no credential for the joiner (a gossip copy), so admitting it adds a member that can never authenticate here');
    });
  }

  it('closed-holder: the member holding the joiner\'s credential admits it', () => {
    assert.ok(cast('closed-holder', 'r-closed-holder').includes(JOINER), 'the guard must not stop the credential holder');
  });

  it('tree-parent: on a braintree the direct parent admits, whatever the hash', () => {
    assert.ok(cast('tree-parent', 'r-tree-parent').includes(JOINER), 'a braintree admits by parent, not by credential');
  });
});
