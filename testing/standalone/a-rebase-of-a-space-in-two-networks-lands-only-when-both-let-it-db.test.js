/**
 * A space carried by two networks moves its RDF base only when every network carrying it here has passed the move, as a deletion removes a
 * space's copy only once no network carries it any more (Q-748, slice A-fix, the review's unproven suspicion "one network's vote overrides
 * another's veto", proven here and decided by the deletion's rule).
 *
 * A deletion opens one round per network (`DELETE /api/spaces/:id`); each passed round takes the space out of ITS network, and the local
 * copy goes only once no network carries it, so a veto in one network keeps the space. A base is one setting and cannot leave one network
 * and stay in the other, so the rebase takes the destructive half of that rule: the door opens one round per network carrying the space,
 * and a member lands the new names only when the rebase round of every network carrying the space here has passed:
 *
 * - while another network's round for the same names is still open or before its deadline, nothing lands, and nothing is written;
 * - a veto (or an expiry) there concludes the round here as superseded, audited, the base unmoved;
 * - once both have passed and their deadlines have come, the names land once.
 *
 * Run: node --test testing/standalone/a-rebase-of-a-space-in-two-networks-lands-only-when-both-let-it-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf, untilAuditWritesLanded } from './_audit-rows.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1, P2 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-two-networks-');
const skip = await mongoSkipReason();
const SPACE = 'shared';
const OLD = { enabled: true, base: 'https://old.example.org/ld/shared/', vocab: 'https://old.example.org/ld/shared/vocab/', baseEpoch: 0 };
const NEW = 'https://new.example.org/ld/shared/';
const HOUR = 3_600_000;
const D1 = '2026-03-01T00:00:00.000Z';
const D2 = '2026-03-02T00:00:00.000Z';

const network = (id, member) => ({
  id, label: id, type: 'club', origin: 'joined', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: member, label: 'Peer', url: `https://${id}.example`, tokenHash: 'h', direction: 'both' }],
});
const round = (roundId, member, deadline, over = {}) => ({
  roundId, type: 'space_rebase', spaceId: SPACE, subjectInstanceId: member, subjectLabel: 'Peer', subjectUrl: '',
  openedAt: new Date(Date.parse(deadline) - 24 * HOUR).toISOString(), deadline,
  votes: [{ instanceId: member, vote: 'yes', castAt: new Date(Date.parse(deadline) - 24 * HOUR).toISOString() }],
  concluded: true, passed: true, rebase: { base: NEW, vocab: `${NEW}vocab/`, epoch: 1 }, ...over,
});

describe('a rebase of a space in two networks', { skip }, () => {
  let inst, mongo, expiry;
  before(async () => {
    mongo = await openTestMongo('rdf_two_networks');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: SPACE, label: 'Shared', folders: [], meta: { rdf: OLD } }],
      networks: [network('n1', P1), network('n2', P2)],
    });
    expiry = await import('../../server/dist/networks/round-expiry.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const nets = () => inst.loader.getConfig().networks;
  const rdfOf = () => inst.loader.getConfig().spaces.find(s => s.id === SPACE)?.meta?.rdf;
  const rows = (operation) => auditRowsOf(mongo, { operation });
  async function fresh(r1, r2) {
    inst.reset();
    nets()[0].pendingRounds = [r1];
    nets()[1].pendingRounds = r2 ? [r2] : [];
    await untilAuditWritesLanded();
    await mongo.getDb().collection('audit_log').deleteMany({});
  }

  it('a veto in the other network holds the base: the round here is superseded, audited', async () => {
    await fresh(round('r1', P1, D1), round('r2', P2, D1, { passed: false, votes: [{ instanceId: P2, vote: 'veto', castAt: D1 }] }));
    expiry.runRoundExpiryTick(Date.parse(D1) + 1);
    assert.deepEqual(rdfOf(), OLD, 'one network\'s yes moved the base another network vetoed');
    assert.equal((await rows('space.rdf_rebase')).length, 0);
    assert.equal((await rows('space.rdf_rebase_superseded')).length, 1);
  });

  it('before the other network\'s deadline nothing lands; once both have passed and come due, the names land once', async () => {
    await fresh(round('r1', P1, D1), round('r2', P2, D2));
    expiry.runRoundExpiryTick(Date.parse(D1) + 1);
    assert.deepEqual(rdfOf(), OLD, 'the base moved before every network carrying the space had let it');
    expiry.runRoundExpiryTick(Date.parse(D2) + 1);
    assert.deepEqual(rdfOf(), { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 1 });
    assert.equal((await rows('space.rdf_rebase')).length, 1, 'the names landed more than once');
  });
});
