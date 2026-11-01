/**
 * An import keeps the instance-bound fields of its own backup and drops those of any other (bundle-40 slice b, `Q-227`; plan 2R R2).
 *
 * ## The rules this file holds
 *
 * A restore is OWN when the export envelope names this instance (`instanceId`) AND the target space (`spaceId`); otherwise FOREIGN (another
 * instance, another space, an older export with no `instanceId`).
 *
 *  1. **Own: `syncBase` (a file's agreement with each peer) and `_resolvedElsewhere` (decisions this instance still owes) are kept.**
 *  2. **Foreign: both are dropped.** They are keyed by the peers and the decisions of the instance that wrote them; another instance's agreements
 *     would make this one skip a conflict it has not agreed to, and another's owed decisions are not this one's.
 *  3. **In both: `deliveredBy` and the retention stamps (`_expireAt`, `_contentExpireAt`) are kept.** A stamp naming anyone but the current
 *     upstream deliverer is inert, and dropping it would make an upstream's deletions decline for ever; the stamps are the record's own tier (D-13).
 *
 * The own/foreign rule is a convenience, not an authority (an MFA admin can write any envelope): it limits the impact to the two fields of rule 2.
 *
 * ## What is red on the base, and what is a PIN
 *
 * The base reads no envelope field, so it keeps every field of every restore: the FOREIGN rows are red; the own rows and rule 3 are PINs (the base
 * already keeps them, and the rewrite must not lose them).
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restore-keeps-an-own-backups-instance-fields-and-drops-a-foreign-ones-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor, exportText, fact } from './_import-door.mjs';
import { untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'ownrestore';
const OTHER_SPACE = 'ownrestore-other';
const T = { timeout: 60_000 };
const STAMP = '2031-05-06T07:08:09.000Z';
const OWED = [{ by: 'peer-x', at: '2026-06-02T00:00:00.000Z', seq: 4, proven: false }];

let door, runner;

/** One fact and one file row carrying every instance-bound and retention field a backup of this instance holds. */
function carrying() {
  return {
    facts: [fact('carry-fact', 20, { over: { deliveredBy: 'peer-up', _expireAt: STAMP, _resolvedElsewhere: OWED } })],
    files: [{
      _id: 'carry/file.md', spaceId: 'elsewhere', path: 'carry/file.md', tags: [], seq: 21, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
      author: { instanceId: 'origin', instanceLabel: 'Origin' }, deliveredBy: 'peer-up', _expireAt: STAMP, syncBase: { 'peer-x': 'sha-agreed' },
    }],
  };
}

/** Import the carrying body under `envelope`; resolves the rows the import stored. */
async function restoreUnder(envelope) {
  const res = await door.post(SPACE, exportText(carrying(), { envelope }));
  assert.ok(res.status === 200 || res.status === 202, `the import answered ${res.status}: ${res.text.slice(0, 200)}`);
  runner ??= await import('../../server/dist/spaces/space-act-runner.js');
  await untilRunnerIdle(runner, door.loader);
  return {
    fact: await door.coll(SPACE, 'facts').findOne({ _id: 'carry-fact' }),
    file: await door.coll(SPACE, 'files').findOne({ _id: 'carry/file.md' }),
  };
}

/** Rule 3: what both restores keep. */
function assertKeptInBoth({ fact: f, file }, who) {
  assert.ok(f && file, `${who}: the restore did not store its rows`);
  assert.equal(f.deliveredBy, 'peer-up', `${who}: deliveredBy of a fact was not kept`);
  assert.equal(file.deliveredBy, 'peer-up', `${who}: deliveredBy of a file row was not kept`);
  for (const [name, row] of [['fact', f], ['file', file]]) {
    assert.ok(row._expireAt instanceof Date && row._expireAt.getTime() === Date.parse(STAMP), `${who}: the retention stamp of the ${name} was not kept as a Date: ${JSON.stringify(row._expireAt)}`);
  }
}

describe('a restore keeps the instance-bound fields of its own backup and drops a foreign one\'s (real MongoDB, real route)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({ suite: 'ownrestore', spaces: [{ id: SPACE, label: 'Own', folders: [] }, { id: OTHER_SPACE, label: 'Other', folders: [] }] });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(SPACE); });

  it('PIN: an own restore (this instance, this space) keeps syncBase and _resolvedElsewhere, deliveredBy and the retention stamps', T, async () => {
    const stored = await restoreUnder({ instanceId: door.instanceId(), spaceId: SPACE });
    assertKeptInBoth(stored, 'own restore');
    assert.deepEqual(stored.file.syncBase, { 'peer-x': 'sha-agreed' }, 'own restore: syncBase of the file was not kept');
    assert.deepEqual(stored.fact._resolvedElsewhere, OWED, 'own restore: _resolvedElsewhere was not kept');
  });

  const foreign = {
    'another instance': () => ({ instanceId: 'some-other-instance', spaceId: SPACE }),
    'another space on this instance': () => ({ instanceId: door.instanceId(), spaceId: OTHER_SPACE }),
    'an older export with no instanceId': () => ({ spaceId: SPACE }),
    'a body with no envelope at all': () => ({}),
  };
  for (const [name, envelope] of Object.entries(foreign)) {
    it(`a foreign restore (${name}) drops syncBase and _resolvedElsewhere and keeps deliveredBy and the retention stamps`, T, async () => {
      const stored = await restoreUnder(envelope());
      assertKeptInBoth(stored, `foreign restore (${name})`);
      assert.equal(stored.file.syncBase, undefined, `foreign restore (${name}): another instance's syncBase was kept: ${JSON.stringify(stored.file.syncBase)}`);
      assert.equal(stored.fact._resolvedElsewhere, undefined, `foreign restore (${name}): another instance's owed decisions were kept: ${JSON.stringify(stored.fact._resolvedElsewhere)}`);
    });
  }
});
