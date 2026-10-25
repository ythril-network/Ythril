/**
 * A fork and the tombstone for it meet ALIKE whichever arrives first (Q-624, design rev 4 section 9a "the arrival half", section 4 step 1,
 * and test 26 of section 16).
 *
 * ## The rule
 *
 * A fork row that a peer's tombstone names, where this instance's deletion authority declines the tombstone (the issuer is not the
 * fork's author, and nothing proves it), is KEPT for a decision in this instance's Review, marked `_resolvedElsewhere` with who decided
 * and when. That is what happens when the fork is stored first and the tombstone arrives after (the decline branch of
 * `applyPeerTombstones`). The same pair arriving the OTHER way round, tombstone first and then the fork relayed by a peer that is not the
 * author, used to be refused as \`tombstoned\`, because a held tombstone governs a record unless its author delivers it: so arrival order
 * decided whether this instance owed a decision at all. The planner now asks the authority's own question for a row carrying \`forkOf\`,
 * and the two orders leave one stored state:
 *
 * - **a tombstone whose issuer does not govern the fork's author** and is not issued here: the fork is stored and marked, in both orders,
 *   with the same \`by\`, \`at\`, \`seq\` and \`proven\` (a stored tombstone does not record how its issuer was proven, so the arrival half
 *   marks \`proven: false\`; the delivery in the first order is made by a peer that is not the issuer, so it is unproven there too);
 * - **a tombstone that GOVERNS the fork's author** (the author's own): the fork is gone in both orders, and nothing marked it;
 * - **S4, a tombstone issued HERE**: the resolve this instance made is its own decision. A fork it resolved behind its own tombstone,
 *   re-delivered by another peer with another author on every cycle, stays \`tombstoned\`: nothing is inserted and no mark is written. A
 *   rule that asked \`tombstoneGoverns\` alone would readmit it each cycle, because this instance does not govern the other author. The
 *   same delivery carries a control (a fork this instance did not resolve, whose foreign tombstone does not govern its author) that IS
 *   stored and marked, so "nothing was stored" is the issuer-here rule and not a delivery that did nothing.
 *
 * ## Derived, never listed
 *
 * The kinds are \`FORKING_FAMILIES\` (\`_fork-kinds.mjs\`), facts included (E1 d); the tombstone type of each is \`TOMBSTONE_TYPE_OF\`. The
 * network is a CLUB, so no peer is an upstream and the only ground a tombstone has is its issuer being proven.
 *
 * ## Seen red
 *
 * On the base (b857da8f) \`FORKING_FAMILIES\` is not exported; with it stubbed in (scratch), a fork stored first is deleted or kept
 * unmarked and a fork arriving after its tombstone is \`tombstoned\`, so neither order leaves a \`_resolvedElsewhere\` mark.
 *
 * Run: node --test testing/standalone/a-fork-and-its-tombstone-meet-alike-in-either-order-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'q624t2either';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const AUTHOR_C = Object.freeze({ instanceId: 'author-c', instanceLabel: 'Author C' });
const ISSUER_A = 'issuer-a';
const DECIDED_AT = '2026-10-20T08:00:00.000Z';
const SUBJECT = 'subject';
const MARK = '_resolvedElsewhere';

let door, FAMILIES, TYPE_OF;

/** The subject every fork here is a version of, stored by this instance. */
const subjectOf = (family) => copyOf(family, S, SUBJECT, 5, 'what this instance wrote', { author: { ...PEER_AUTHOR } });
/** A fork row of `family` as a peer replicates it: another author's body, under the id its body derives. */
async function forkRowOf(family, text, author) {
  const body = copyOf(family, S, SUBJECT, 5, text, { author: { ...author } });
  return { ...body, _id: await forkIdOf(family, SUBJECT, 5, body), forkOf: SUBJECT };
}
const tombstoneOf = (family, id, issuer, extra = {}) =>
  build.tombstone(S, id, TYPE_OF[family], 7, { instanceId: issuer, deletedAt: DECIDED_AT, ...extra });

const deliverForks = (family, rows) => door.push('/batch-upsert', { [family]: rows }, { spaceId: S, networkId: door.NET, token: TOKEN });
const deliverTombstones = (rows) => door.push('/tombstones', { tombstones: rows }, { spaceId: S, networkId: door.NET, token: TOKEN });
const held = (family, id) => door.coll(S, family).findOne({ _id: id });
const marksOf = (row) => (row?.[MARK] ?? []).map(m => ({ by: m.by, at: m.at, seq: m.seq, proven: m.proven }));

async function fresh(family) {
  await door.reset();
  await door.coll(S, family).insertOne(subjectOf(family));
  await door.raiseVersionTo(S, 5);
}

describe('a fork and its tombstone meet alike in either order (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q624t2_either', spaces: [S], type: 'club' });
    ({ TOMBSTONE_TYPE_OF: TYPE_OF } = await import('../../server/dist/config/types.js'));
    FAMILIES = await forkingFamilies();
  });
  after(async () => { await door?.close(); });

  it('a tombstone whose issuer does not govern the author: fork first and tombstone first leave the same marked fork', async () => {
    const failures = [];
    for (const family of FAMILIES) {
      const fork = await forkRowOf(family, 'what C wrote', AUTHOR_C);
      const tomb = tombstoneOf(family, fork._id, ISSUER_A);

      await fresh(family);
      await deliverForks(family, [fork]);
      await deliverTombstones([tomb]);
      const forkFirst = await held(family, fork._id);

      await fresh(family);
      await deliverTombstones([tomb]);
      await deliverForks(family, [fork]);
      const tombstoneFirst = await held(family, fork._id);

      if (!forkFirst) failures.push(`${family}: fork first: the fork was deleted by a tombstone whose issuer does not govern its author`);
      if (!tombstoneFirst) failures.push(`${family}: tombstone first: the fork was refused (tombstoned) where the other order keeps it for a decision here`);
      if (forkFirst && tombstoneFirst) {
        const a = marksOf(forkFirst); const b = marksOf(tombstoneFirst);
        if (a.length !== 1) failures.push(`${family}: fork first: ${a.length} marks, expected 1 (${JSON.stringify(forkFirst[MARK])})`);
        if (JSON.stringify(a) !== JSON.stringify(b)) failures.push(`${family}: the orders disagree: fork first ${JSON.stringify(a)}, tombstone first ${JSON.stringify(b)}`);
        const expected = [{ by: ISSUER_A, at: DECIDED_AT, seq: 7, proven: false }];
        if (JSON.stringify(b) !== JSON.stringify(expected)) failures.push(`${family}: tombstone first marked ${JSON.stringify(b)}, expected ${JSON.stringify(expected)}`);
      }
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s): ${failures.join('; ')}`);
  });

  it('a tombstone that GOVERNS the fork\'s author removes it in both orders, and marks nothing', async () => {
    const failures = [];
    for (const family of FAMILIES) {
      const fork = await forkRowOf(family, 'what the peer wrote', PEER_AUTHOR);
      const tomb = tombstoneOf(family, fork._id, PEER);

      await fresh(family);
      await deliverForks(family, [fork]);
      if (!(await held(family, fork._id))) failures.push(`${family}: fixture check: the fork did not land first`);
      await deliverTombstones([tomb]);
      const forkFirst = await held(family, fork._id);

      await fresh(family);
      await deliverTombstones([tomb]);
      await deliverForks(family, [fork]);
      const tombstoneFirst = await held(family, fork._id);

      if (forkFirst) failures.push(`${family}: fork first: the author's own tombstone did not remove the fork`);
      if (tombstoneFirst) failures.push(`${family}: tombstone first: the author's own tombstone did not refuse the fork`);
      if ((await door.coll(S, family).countDocuments({ [MARK]: { $exists: true } })) !== 0) failures.push(`${family}: a mark was written for a tombstone that governs`);
      if ((await door.coll(S, family).findOne({ _id: SUBJECT }))?.[FORK_FIXTURE[family].field] !== 'what this instance wrote') failures.push(`${family}: the subject changed`);
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s): ${failures.join('; ')}`);
  });

  it('S4: a fork this instance resolved (its own tombstone) stays tombstoned however another peer re-delivers it; a control fork beside it is marked', async () => {
    const failures = [];
    for (const family of FAMILIES) {
      const resolvedHere = await forkRowOf(family, 'the version I resolved away', AUTHOR_C);
      const control = await forkRowOf(family, 'a version nobody here decided', AUTHOR_C);
      await fresh(family);
      // This instance's own resolve left this tombstone (`removeWithTombstones`, issued here): the fork row is gone and the tombstone stays.
      await door.coll(S, 'tombstones').insertOne(tombstoneOf(family, resolvedHere._id, door.instanceId, { issuedHere: true }));
      // A foreign tombstone for the control, whose issuer does not govern its author: the control is admitted and marked, in this same delivery.
      await deliverTombstones([tombstoneOf(family, control._id, ISSUER_A)]);
      for (let cycle = 1; cycle <= 3; cycle++) {
        await deliverForks(family, [resolvedHere, control]);
        const again = await held(family, resolvedHere._id);
        if (again) failures.push(`${family}: cycle ${cycle}: a fork this instance resolved was readmitted (${JSON.stringify(marksOf(again))})`);
      }
      if ((await door.coll(S, family).countDocuments({ _id: resolvedHere._id })) !== 0) failures.push(`${family}: the resolved fork is stored`);
      const kept = await held(family, control._id);
      if (!kept) failures.push(`${family}: the control fork was refused: the delivery proves nothing about the issuer-here rule`);
      else if (marksOf(kept).length !== 1) failures.push(`${family}: the control fork carries ${marksOf(kept).length} marks, expected 1`);
      if ((await door.coll(S, family).countDocuments({ [MARK]: { $exists: true } })) !== 1) failures.push(`${family}: expected exactly one marked row (the control's); a mark was written for the resolved fork, or the control's is missing`);
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s): ${failures.join('; ')}`);
  });
});
