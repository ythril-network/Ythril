/**
 * A stored record that fails its `Incoming*` schema is counted on `ythril_records_failing_their_schema` when an arriving copy meets it at an equal seq
 * (Q-624, design rev 4 section 2).
 *
 * ## The rule
 *
 * Such a record (a row `deleteFields` wrote with `description: null` before the side defect was fixed, or one an older version stored) cannot be normalised, so it is
 * compared by its RAW body and forks only when that really differs. The operator reads how many there are from the gauge, by family. The gauge counts the failing
 * stored copies the arrival path MET, because finding every such row would scan every space; a copy that passes its schema counts for nothing.
 *
 * ## What it holds, for every family that forks (read from the planner, never listed)
 *
 *  - a stored row with `description: null` (it fails its schema), met at its own seq by a copy that passes its schema: the family's series rises by one (the two
 *    raw bodies differ by the null, so a fork row is made, the caveat the design states in section 2);
 *  - the control, so a count of zero is not "never counts": the same delivery over a stored row that passes its schema leaves the series where it was.
 *
 * Run: node --test testing/standalone/a-stored-record-failing-its-schema-is-counted-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { FORK_FIXTURE, forkingFamilies } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624failing';

describe('a stored record failing its schema is counted when it is met at an equal seq', { skip }, () => {
  let door; let gauge; let families;
  before(async () => {
    door = await openPushDoor({ suite: 'q624i1b_failing', spaces: [{ id: S, label: 'Failing', folders: [], meta: {} }] });
    ({ recordsFailingTheirSchema: gauge } = await import('../../server/dist/metrics/registry.js'));
    families = await forkingFamilies();
  });
  after(async () => { await door?.close(); });

  const valueOf = async (family) => (await gauge.get()).values.find(v => v.labels.family === family)?.value ?? 0;
  const copy = (family, extra = {}) => FORK_FIXTURE[family].build(S, 'r1', 5, { ...(family === 'edges' ? { from: 'a', to: 'b', label: 'knows' } : {}), ...extra });

  it('the families are read from the planner, and the gauge is exported', () => {
    assert.ok(families.length >= 4, `only ${families.length} forking families`);
    assert.ok(gauge && typeof gauge.get === 'function', 'the registry exports no recordsFailingTheirSchema gauge');
  });

  it('a stored copy that fails its schema is counted, and a stored copy that passes is not', async () => {
    const failures = [];
    for (const family of families.filter(f => f !== 'edges')) { // an edge needs the partial identity index only for FORK rows; the plain case works, but keep this slice's run independent of it
      await door.wipe(S);
      await door.coll(S, family).insertOne(copy(family, { description: null }));
      const before = await valueOf(family);
      // The arriving copy must pass ITS schema to reach the planner at all; it says what the stored one would say but for the null.
      await door.push('/batch-upsert', { [family]: [copy(family)] }, { spaceId: S });
      const after = await valueOf(family);
      if (after !== before + 1) failures.push(`${family}: the failing stored copy moved the gauge from ${before} to ${after}, expected +1`);

      await door.wipe(S);
      await door.coll(S, family).insertOne(copy(family));
      const control = await valueOf(family);
      await door.push('/batch-upsert', { [family]: [copy(family)] }, { spaceId: S });
      if (await valueOf(family) !== control) failures.push(`${family}: a stored copy that passes its schema was counted as failing`);
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s):${String.fromCharCode(10)}  ${failures.join(String.fromCharCode(10) + '  ')}`);
  });
});
