/**
 * A shared space holds one rebase at a time, and two passed rebase rounds for one space land ONE base on every member (Q-748, slice A-fix,
 * review finding 1).
 *
 * - While any `space_rebase` round for the space is held here and not yet landed (open, or passed and owed), from any proposer, a door's
 *   rebase to another base is refused 409 `rdf_rebase_pending`, naming the held round's base and deadline, on REST and MCP alike. The
 *   identical repeat of this instance's own proposal still answers the round in progress.
 * - Two members can still propose at the same moment before either sees the other's round. A member that holds two passed rounds for one
 *   space lands exactly one: the earlier deadline, then the lower round id, a rule every member computes alike from the rounds themselves.
 *   So a member holding [R1, R2] and one holding [R2, R1] end on the same base and epoch. The other round is concluded as superseded,
 *   with one `space.rdf_rebase_superseded` audit row, never marked landed in silence.
 *
 * Run: node --test testing/standalone/a-shared-space-holds-one-rebase-at-a-time-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-one-rebase-');
const skip = await mongoSkipReason();
const SPACE = 'shared';
const OLD = { enabled: true, base: 'https://old.example.org/ld/shared/', vocab: 'https://old.example.org/ld/shared/vocab/', baseEpoch: 0 };
const B1 = 'https://one.example.org/ld/shared/';
const B2 = 'https://two.example.org/ld/shared/';
const HOUR = 3_600_000;

const network = () => ({
  id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
});

/** A passed rebase round another member proposed, as adoption stores it. */
const passedRound = (roundId, base, deadline) => ({
  roundId, type: 'space_rebase', spaceId: SPACE, subjectInstanceId: P1, subjectLabel: 'Peer', subjectUrl: '',
  openedAt: new Date(Date.parse(deadline) - 24 * HOUR).toISOString(), deadline,
  votes: [{ instanceId: P1, vote: 'yes', castAt: new Date(Date.parse(deadline) - 24 * HOUR).toISOString() }],
  concluded: true, passed: true, rebase: { base, vocab: `${base}vocab/`, epoch: 1 },
});

describe('a shared space holds one rebase at a time', { skip }, () => {
  let inst, mongo, expiry, auditMod;
  before(async () => {
    mongo = await openTestMongo('rdf_one_rebase');
    inst = await bootSchemaInstance(dir, { spaces: [{ id: SPACE, label: 'Shared', folders: [], meta: { rdf: OLD } }], networks: [network()] });
    expiry = await import('../../server/dist/networks/round-expiry.js');
    auditMod = await import('../../server/dist/audit/audit.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const netOf = () => inst.loader.getConfig().networks.find(n => n.id === NET_ID);
  const rdfOf = () => inst.loader.getConfig().spaces.find(s => s.id === SPACE)?.meta?.rdf;
  const rebaseRounds = () => netOf().pendingRounds.filter(r => r.type === 'space_rebase');
  async function rows(operation) {
    for (let i = 0; i < 4000 && auditMod.auditWritesPending() > 0; i++) {
      // waits-differently: bounded by turns, every fiftieth a stated 15 ms timer, as the settle matrix waits for its inserts.
      await new Promise(r => (i % 50 === 49 ? setTimeout(r, 15) : setImmediate(r)));
    }
    return mongo.getDb().collection('audit_log').find({ operation }).toArray();
  }
  async function fresh(rounds = []) {
    inst.reset();
    netOf().pendingRounds = rounds;
    await mongo.getDb().collection('audit_log').deleteMany({});
  }

  for (const door of ['space-patch', 'mcp-schema-update']) {
    it(`${door}: while this instance's own round is held, a rebase to another base is 409 rdf_rebase_pending naming its base and deadline`, async () => {
      await fresh();
      const first = await inst.doors['space-patch'](SPACE, { rdf: { enabled: true, base: B1, rebase: true } });
      assert.equal(first.refused, false, first.text.slice(0, 300));
      const held = rebaseRounds()[0];
      assert.ok(held, 'the first rebase opened no round');
      const second = await inst.doors[door](SPACE, { rdf: { enabled: true, base: B2, rebase: true } });
      assert.equal(second.refused, true, `a second rebase was taken while one is held: ${second.text.slice(0, 300)}`);
      assert.equal(second.status, 409, second.text.slice(0, 300));
      // REST answers the code in its body; MCP in its structured content.
      assert.match(`${second.text} ${JSON.stringify(second.body ?? null)}`, /rdf_rebase_pending/);
      assert.ok(second.text.includes(B1), `the refusal names the held round's base: ${second.text.slice(0, 300)}`);
      assert.ok(second.text.includes(held.deadline), `the refusal names the held round's deadline: ${second.text.slice(0, 300)}`);
      assert.equal(rebaseRounds().length, 1, 'a second round was opened');
      const repeat = await inst.doors[door](SPACE, { rdf: { enabled: true, base: B1, rebase: true } });
      assert.equal(repeat.refused, false, `the identical repeat answers the round in progress: ${repeat.text.slice(0, 300)}`);
      assert.equal(rebaseRounds().length, 1);
    });
  }

  it('a round another member proposed, passed and not yet landed, refuses a rebase too; once landed it does not', async () => {
    const theirs = passedRound('peer-round', B1, new Date(Date.now() + HOUR).toISOString());
    await fresh([theirs]);
    const refused = await inst.doors['space-patch'](SPACE, { rdf: { enabled: true, base: B2, rebase: true } });
    assert.equal(refused.status, 409, refused.text.slice(0, 300));
    assert.match(refused.text, /rdf_rebase_pending/);
    theirs.appliedHere = true;
    const taken = await inst.doors['space-patch'](SPACE, { rdf: { enabled: true, base: B2, rebase: true } });
    assert.equal(taken.refused, false, taken.text.slice(0, 300));
  });

  const cases = [
    ['different deadlines: the earlier one lands', passedRound('r-2', B1, '2026-03-01T00:00:00.000Z'), passedRound('r-1', B2, '2026-03-01T01:00:00.000Z'), B1],
    ['equal deadlines: the lower round id lands', passedRound('r-b', B1, '2026-03-01T00:00:00.000Z'), passedRound('r-a', B2, '2026-03-01T00:00:00.000Z'), B2],
  ];
  for (const [what, R1, R2, winner] of cases) {
    it(`two passed rounds for one space, held in either order, land one base: ${what}`, async () => {
      const after = Date.parse(R2.deadline) + 1;
      const ends = [];
      for (const order of [[R1, R2], [R2, R1]]) {
        await fresh(order.map(r => structuredClone(r)));
        expiry.runRoundExpiryTick(after);
        ends.push(rdfOf());
        const landed = await rows('space.rdf_rebase');
        assert.equal(landed.length, 1, `one landing per member: ${JSON.stringify(landed)}`);
        const superseded = await rows('space.rdf_rebase_superseded');
        assert.equal(superseded.length, 1, `the other round is concluded as superseded, audited: ${JSON.stringify(superseded)}`);
        const loser = winner === R1.rebase.base ? R2 : R1;
        assert.ok(String(superseded[0].path).includes(loser.roundId), superseded[0].path);
      }
      assert.deepEqual(ends[0], ends[1], 'two members holding the rounds in different orders ended on different bases');
      assert.deepEqual(ends[0], { enabled: true, base: winner, vocab: `${winner}vocab/`, baseEpoch: 1 });
    });
  }

  it('a passed round for an epoch this member already holds is concluded as superseded, audited, and moves nothing', async () => {
    const late = passedRound('late', B2, '2026-03-01T00:00:00.000Z');
    await fresh([late]);
    inst.loader.getConfig().spaces.find(s => s.id === SPACE).meta.rdf = { enabled: true, base: B1, vocab: `${B1}vocab/`, baseEpoch: 1 };
    expiry.runRoundExpiryTick(Date.parse(late.deadline) + 1);
    assert.equal(rdfOf().base, B1);
    assert.equal((await rows('space.rdf_rebase')).length, 0);
    assert.equal((await rows('space.rdf_rebase_superseded')).length, 1);
  });
});
