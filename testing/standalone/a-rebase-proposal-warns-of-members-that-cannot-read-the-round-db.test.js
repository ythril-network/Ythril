/**
 * A rebase proposal says which members cannot read the round, on both doors, as every other settings write names the members that may refuse
 * what it sets (Q-748, bundle-269 lens sweep, finding 10; `R6-7`, `sync/meta-skew.ts`).
 *
 * ## The defect it prevents
 *
 * `rdf.rebase: true` on a shared space opens a `space_rebase` round on every network carrying it, and the answer was `202 vote_pending` with
 * the rounds and nothing else. A member on a release before the one that knows the round (6.6.0) neither votes on it nor applies it: on a
 * closed or braintree network the round cannot pass until it upgrades, and on a democratic one its missing yes counts against the
 * majority. Every other write that sets something an earlier release cannot read answers with a `warnings` row naming those members; this
 * one said nothing, so a proposer found out when the round sat open until its deadline.
 *
 * ## What it holds
 *
 * - Both doors (the space PATCH and `schema_update`) answer the `members_may_not_read_round` row beside the 202: the round type, the release
 *   that reads it, how many members are behind and which (a member never heard from counts, as for a key).
 * - A network whose members all run a release that reads the round gets no row.
 * - A member in two of the networks is one member.
 *
 * Run: node --test testing/standalone/a-rebase-proposal-warns-of-members-that-cannot-read-the-round-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-rebase-skew-');
const skip = await mongoSkipReason();
const SPACE = 'shared';
const OLD = { enabled: true, base: 'https://old.example.org/ld/shared/', vocab: 'https://old.example.org/ld/shared/vocab/', baseEpoch: 0 };
const NEW_BASE = 'https://new.example.org/ld/shared/';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const CHECKED = '2026-11-01T00:00:00.000Z';

const member = (instanceId, label, version) => ({
  instanceId, label, url: `https://${label}.example`, tokenHash: 'h', direction: 'both',
  ...(version !== undefined ? { version, versionCheckedAt: CHECKED } : {}),
});
const network = (members) => ({
  id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [], members,
});

describe('a rebase proposal names the members that cannot read the round', { skip }, () => {
  let inst, current;
  before(async () => {
    await openTestMongo('rdf_rebase_skew');
    inst = await bootSchemaInstance(dir, { spaces: [{ id: SPACE, label: 'Shared', folders: [], meta: { rdf: OLD } }], networks: [network([])] });
    ({ SERVER_VERSION: current } = await import('../../server/dist/util/server-version.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const netOf = () => inst.loader.getConfig().networks.find(n => n.id === NET_ID);
  async function propose(door, members) {
    inst.reset();
    const net = netOf();
    net.members = members;
    net.pendingRounds = [];
    return inst.doors[door](SPACE, { rdf: { enabled: true, base: NEW_BASE, rebase: true } });
  }
  /** The `warnings` rows of an answer, as REST carries them in its body and MCP in its structured content. */
  const rowsOf = (answer) => (answer.body?.warnings ?? []).filter(w => w.code === 'members_may_not_read_round');

  for (const door of ['space-patch', 'mcp-schema-update']) {
    describe(door, () => {
      it('a member below the release that reads the round is named in a warnings row beside the vote', async () => {
        const answer = await propose(door, [member(P1, 'old-peer', '6.5.0'), member(P2, 'current-peer', current)]);
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
        assert.ok(netOf().pendingRounds.some(r => r.type === 'space_rebase'), 'the proposal opened no round');
        const rows = rowsOf(answer);
        assert.equal(rows.length, 1, `no warning of the members that cannot read the round: ${answer.text.slice(0, 500)}`);
        assert.equal(rows[0].since, '6.6.0');
        assert.deepEqual(rows[0].keys, ['space_rebase']);
        assert.equal(rows[0].memberCount, 1, 'only the member below the release is behind');
        assert.deepEqual(rows[0].members, ['old-peer']);
        assert.match(rows[0].message, /space_rebase/);
        assert.match(rows[0].message, /vote|apply/);
      });

      it('a member never heard from is named too, and counted as such', async () => {
        const answer = await propose(door, [member(P1, 'silent-peer')]);
        const rows = rowsOf(answer);
        assert.equal(rows.length, 1, answer.text.slice(0, 500));
        assert.deepEqual(rows[0].members, ['silent-peer']);
        assert.match(rows[0].message, /not yet heard from/);
      });

      it('a network whose members all read the round gets no row', async () => {
        const answer = await propose(door, [member(P1, 'peer-one', current), member(P2, 'peer-two', current)]);
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
        assert.deepEqual(rowsOf(answer), [], 'a warning about nothing');
      });
    });
  }

  it('a member in two networks is one member', async () => {
    inst.reset();
    const second = { ...network([member(P1, 'old-peer', '6.5.0')]), id: 'net-2', label: 'Net two' };
    const cfg = inst.loader.getConfig();
    cfg.networks.push(second);
    try {
      const net = netOf();
      net.members = [member(P1, 'old-peer', '6.5.0')];
      net.pendingRounds = [];
      const answer = await inst.doors['space-patch'](SPACE, { rdf: { enabled: true, base: NEW_BASE, rebase: true } });
      const rows = rowsOf(answer);
      assert.equal(rows.length, 1, answer.text.slice(0, 500));
      assert.equal(rows[0].memberCount, 1, 'one member of two networks was counted twice');
    } finally {
      cfg.networks = cfg.networks.filter(n => n.id !== 'net-2');
    }
  });
});
