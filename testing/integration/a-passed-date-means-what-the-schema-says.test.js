/**
 * `whenDuePasses` end to end: the read paths AND the status filter, against a real instance.
 *
 * ## Why this exists on top of the unit gate
 *
 * `standalone/a-passed-date-means-what-the-schema-says.test.js` proves the resolver, the derivation and that
 * every reader reaches them. None of that proves the FILTER is right, because the filter is a Mongo query —
 * the standalone suite asserts its shape, not its result set, and a query whose shape is plausible can still
 * match the wrong rows.
 *
 * That gap has cost this repository twice in one day. `F-25`'s recorder was refused by Mongo on every write,
 * swallowed by design, and answered `writers: []` — indistinguishable from a healthy answer. `U-15` stored a
 * setting correctly and never returned it. Both type-checked, both passed every source gate, and both were
 * found by driving the thing rather than reading it.
 *
 * ## The truth table, and why the last row is the one worth having
 *
 * One space, two chrono types, both entries stored `active` with a due moment years in the past:
 *
 * | read | a type that says `nothing` | a type that says nothing at all |
 * |---|---|---|
 * | single-entry GET | `active` | `overdue` |
 * | list | `active` | `overdue` |
 * | filter `status=overdue` | absent | matched |
 * | filter `status=active` | **matched** | absent |
 *
 * The last row is the direction that hides records rather than inventing them. The `upcoming`/`active`
 * branch of the query excludes entries whose due moment has passed — correct while every type derives, and
 * on an exempt type it would hide exactly the records the filter names, silently, from an operator who
 * asked for their open ones.
 *
 * Run: node --test testing/integration/a-passed-date-means-what-the-schema-says.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, delWithBody, readRecord, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const RUN = Date.now();
const SPACE = `duepasses-${RUN}`;
/** Years in the past, so the due moment cannot be near a boundary however slowly the suite runs. */
const LONG_PAST = '2020-03-01T00:00:00.000Z';

let token;
let derivingId;
let exemptId;

/**
 * The entries this space holds, by type, as the API reports them right now.
 *
 * `deriveStatus: true` IS THE SUBJECT, not a detail. The list route this replaced derived the status
 * unconditionally, so a conversion that dropped the flag would compare the STORED value against an
 * expectation written about the derived one — and pass for the exempt type, which is the half that was
 * already correct.
 */
async function statusByType(status) {
  const r = await readCollection(INSTANCES.a, token, SPACE, 'chrono', {
    limit: 20, deriveStatus: true, ...(status ? { filter: { status } } : {}),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return Object.fromEntries((r.results ?? []).map(e => [e.type, e.status]));
}

describe('a passed date means what the chrono type says', () => {
  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: 'DuePasses' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // `deploy` records something that HAPPENED; `invoice` is a real deadline and states nothing, so it takes
    // the built-in behaviour. Two types in one space is the case that matters — a space-wide switch would
    // not have needed the resolver.
    const meta = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, {
      meta: { typeSchemas: { chrono: { deploy: { whenDuePasses: 'nothing' }, invoice: {} } } },
    });
    assert.equal(meta.status, 200, JSON.stringify(meta.body));

    for (const [type, into] of [['deploy', 'exempt'], ['invoice', 'deriving']]) {
      const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/chrono`, {
        title: `${type} ${RUN}`, type, startsAt: LONG_PAST, status: 'active',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      if (into === 'exempt') exemptId = r.body._id; else derivingId = r.body._id;
    }
  });

  after(async () => {
    // `confirm`, because a space in no network refuses a bodyless DELETE — and these suites share one
    // instance pair, so a leaked fixture fails somebody else's test. Reported, never swallowed.
    const r = await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true })
      .catch(err => ({ status: 0, body: String(err) }));
    if (r.status !== 204 && r.status !== 200) {
      console.error(`cleanup: space '${SPACE}' was not deleted (${r.status})`, JSON.stringify(r.body));
    }
  });

  it('a single-entry GET returns the STORED status for an exempt type, and derives for the other', async () => {
    const exempt = await readRecord(INSTANCES.a, token, SPACE, 'chrono', exemptId);
    assert.equal(exempt.status, 200, JSON.stringify(exempt.body));
    assert.equal(exempt.body.status, 'active',
      'a type whose schema says a passed date means nothing must come back as it was STORED — this is the '
      + 'whole of the reported defect');

    const deriving = await readRecord(INSTANCES.a, token, SPACE, 'chrono', derivingId);
    assert.equal(deriving.status, 200, JSON.stringify(deriving.body));
    assert.equal(deriving.body.status, 'overdue',
      'a type that states nothing must be unchanged — absent is the previous behaviour, which is the firm '
      + 'half of the ruling');
  });

  it('the LIST path agrees with the single-entry path', async () => {
    // Two read paths, one rule. They resolve the policy independently, so this is the assertion that would
    // catch one of them being wired and the other not.
    assert.deepEqual(await statusByType(), { deploy: 'active', invoice: 'overdue' });
  });

  it('filtering by overdue does not match the exempt type', async () => {
    assert.deepEqual(await statusByType('overdue'), { invoice: 'overdue' });
  });

  it('filtering by active still FINDS the exempt type — the direction that hides records', async () => {
    /*
     * The `upcoming`/`active` branch excludes entries whose due moment has passed, which is right while
     * every type derives. On an exempt type that exclusion would hide exactly the records the filter names,
     * silently, from an operator asking for their open ones — and the reporter's own monitor did precisely
     * this comparison against a past-dated record and found nothing, for 1 687 of 1 806 entries.
     */
    assert.deepEqual(await statusByType('active'), { deploy: 'active' });
  });

  it('a terminal status is untouched by either policy', async () => {
    const done = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/chrono`, {
      title: `closed ${RUN}`, type: 'deploy', startsAt: LONG_PAST, status: 'completed',
    });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const r = await readRecord(INSTANCES.a, token, SPACE, 'chrono', done.body._id);
    assert.equal(r.body.status, 'completed', 'nothing derives over a status that is already terminal');
  });
});
