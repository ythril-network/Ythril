/**
 * A write group larger than its ceilings is refused `413 write_group_too_large`, naming the ceiling, BEFORE a transaction opens; one at the
 * ceiling lands; and the next group after a refusal lands as any other (`Q-760`; design e, R10; vet-2 S5).
 *
 * ## The rule
 *
 * `GROUP_MAX_RECORDS` (5 000 records), `GROUP_MAX_OPERATIONS` (50 000 writes: records and link rows) and `GROUP_MAX_BYTES` (32 MiB of what the
 * group writes, measured by `writeGroupSize` with `operationBytes`) are checked before the session opens. Past one, nothing is sent.
 *
 * ## Why before the session
 *
 * The probe (E5) rolled back 100 MB in one transaction with a TRANSIENT label: the bound would re-run that group until its 45 s deadline,
 * holding every position-paged reader of the space below its floor the whole time. A group the store cannot take must never reach it.
 *
 * ## Seen red
 *
 * On the base (3f48206ac) the fixture writes the plans with `commitPlans`, which has no ceiling: 5 001 records land (red lines in the Q-760
 * Work-Log). Mutation: the record ceiling compared with `>` one place off (5 001 lands, or 5 000 is refused).
 *
 * Run: node --test testing/standalone/a-write-group-over-its-ceilings-is-refused-before-a-session-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openWriteGroupFixture, factId, insertFact, settle, countTransactions } from './_write-group.mjs';

const skip = await mongoSkipReason();
const SLOW = 120_000;

let fx;
const facts = (n, from = 1) => Array.from({ length: n }, (_, i) => insertFact(factId(from + i), `fact ${from + i}`));
/** The group's bytes the code's way (`writeGroupSize`, which the ceiling reads). */
const bytesOf = (plans) => fx.group.writeGroupSize(plans).bytes;

/** Refused before a transaction opened, as `write_group_too_large` naming `ceiling`; nothing of it stored. */
async function assertRefusedBeforeASession(plans, ceiling) {
  const txns = countTransactions(fx.mongo);
  let out;
  try { out = await settle(fx.commitGroup(plans)); } finally { txns.restore(); }
  const landed = await fx.coll('facts').countDocuments({ _id: { $in: plans.map(p => p.id) } });
  assert.equal(landed, 0, `${landed} record(s) of a group over its ${ceiling} ceiling landed`);
  assert.ok(out.error, `a group over its ${ceiling} ceiling was answered as written`);
  assert.equal(out.error.code, 'write_group_too_large', `the refusal is not write_group_too_large: ${out.error.name}: ${out.error.message}`);
  assert.equal(out.error.status, 413);
  assert.equal(out.error.ceiling, ceiling, `the refusal names the ${out.error.ceiling} ceiling, not ${ceiling}`);
  assert.equal(txns.started(), 0, 'a transaction was opened for a group over its ceiling');
}

describe('a write group over its ceilings', { skip }, () => {
  before(async () => { fx = await openWriteGroupFixture('writegroupceiling'); });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('5 000 records land as one group', { timeout: SLOW }, async () => {
    const out = await settle(fx.commitGroup(facts(5_000)));
    assert.equal(out.error, undefined, `a group of 5 000 records failed: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({}), 5_000);
  });

  it('5 001 records are refused before a session, and the next group lands', { timeout: SLOW }, async () => {
    await assertRefusedBeforeASession(facts(5_001), 'records');
    const out = await settle(fx.commitGroup(facts(2, 9_000)));
    assert.equal(out.error, undefined, `the group after a refusal failed: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({}), 2);
  });

  it('a group of exactly 32 MiB lands; one byte more is refused before a session, and the next group lands', { timeout: SLOW }, async () => {
    const CEILING = 32 * 1024 * 1024;
    // Three records, each under the 16 MiB document limit; the padding fills the group to the ceiling exactly (one ASCII character is one byte).
    const build = (extra) => {
      const bare = [1, 2, 3].map(n => insertFact(factId(n), `padded ${n}`, { pad: '' }));
      const fill = CEILING - bytesOf(bare) + extra;
      const each = Math.floor(fill / 3);
      return [1, 2, 3].map((n, i) => insertFact(factId(n), `padded ${n}`, { pad: 'x'.repeat(i === 2 ? fill - 2 * each : each) }));
    };
    const atCeiling = build(0);
    assert.equal(bytesOf(atCeiling), CEILING, 'fixture: the group is not exactly at the ceiling');
    const over = build(1);
    await assertRefusedBeforeASession(over, 'bytes');
    const out = await settle(fx.commitGroup(atCeiling));
    assert.equal(out.error, undefined, `a group of exactly 32 MiB failed: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({}), 3);
    const next = await settle(fx.commitGroup(facts(1, 9_100)));
    assert.equal(next.error, undefined, `the group after the byte refusal failed: ${next.error?.message}`);
  });
});
