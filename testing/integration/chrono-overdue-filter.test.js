/**
 * Integration: `status=overdue` returns every overdue entry, against a real Mongo.
 *
 * `chrono-list-filter-composes.test.js` proves the QUERY the builder produces. This proves Mongo answers it
 * the way that query is meant to — a `$or` branch carrying its own `$expr` is exactly the construction most
 * likely to be legal-but-different from what it reads like, and no amount of asserting on the object literal
 * would show that.
 *
 * ## CH-1
 *
 * `overdue` is derived on read, so the filter was translated to *"stored `upcoming`/`active`, past due"*. But
 * `overdue` is also a legal stored value on every write door, so an entry a caller had marked was invisible
 * to the filter that names it. Both kinds are matched now.
 *
 * Run: node --test testing/integration/chrono-overdue-filter.test.js
 * (needs the compose stack — `npm run test:integration`)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
const created = [];

const PAST = '2020-03-01T00:00:00Z';
const FUTURE = '2099-03-01T00:00:00Z';

/** Create one entry and remember it for cleanup. Titles are unique so the assertions can find their own. */
async function mk(title, body) {
  const r = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/chrono', {
    title, type: 'deadline', ...body,
  });
  assert.equal(r.status, 201, `creating "${title}" failed: ${JSON.stringify(r.body)}`);
  created.push(r.body._id);
  return r.body._id;
}

const listByStatus = async (status) => {
  // `deriveStatus: true` because the route this replaced derived unconditionally — and this whole file is
  // about `overdue`, which only exists once the clock has been read.
  const r = await readCollection(INSTANCES.a, tokenA, 'general', 'chrono',
    { limit: 500, deriveStatus: true, filter: { status } });
  assert.equal(r.status, 200);
  return r.results;
};

before(async () => {
  // `token.txt`, which is what every other integration suite reads. Reading `config.json` works on a
  // Windows working copy and fails in CI with `EACCES`: the container writes that file as root, while
  // `token.txt` is deposited for the tests. The suite's existing convention was right; inventing a second
  // way to get the same value is what cost a CI run.
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

after(async () => {
  for (const id of created) {
    await del(INSTANCES.a, tokenA, `/api/brain/spaces/general/chrono/${id}`).catch(() => {});
  }
});

describe('chrono status=overdue finds both kinds', () => {
  let derivedId, storedId, futureId, doneId;

  before(async () => {
    derivedId = await mk('ch1 derived overdue', { startsAt: PAST, status: 'upcoming' });
    storedId = await mk('ch1 stored overdue', { startsAt: FUTURE, status: 'overdue' });
    futureId = await mk('ch1 still upcoming', { startsAt: FUTURE, status: 'upcoming' });
    doneId = await mk('ch1 completed in the past', { startsAt: PAST, status: 'completed' });
  });

  it('the derived one — stored upcoming, due moment passed', async () => {
    const ids = (await listByStatus('overdue')).map(c => c._id);
    assert.ok(ids.includes(derivedId), 'a past-due upcoming entry is overdue and always was');
  });

  it('AND the one a caller stored as overdue — this is CH-1', async () => {
    const ids = (await listByStatus('overdue')).map(c => c._id);
    assert.ok(ids.includes(storedId),
      'an entry somebody marked overdue was invisible to the filter that names it');
  });

  it('and nothing that is not overdue', async () => {
    const ids = (await listByStatus('overdue')).map(c => c._id);
    assert.ok(!ids.includes(futureId), 'a future entry must not be listed as overdue');
    assert.ok(!ids.includes(doneId), 'a completed entry is never re-derived, however old');
  });

  it('the derived entry reads back AS overdue, so the filter and the row agree', async () => {
    const rows = await listByStatus('overdue');
    const row = rows.find(c => c._id === derivedId);
    assert.equal(row.status, 'overdue',
      'a row returned by the overdue filter but labelled `upcoming` is worse than not returning it');
  });

  it('status=upcoming excludes the now-overdue one and keeps the future one', async () => {
    const ids = (await listByStatus('upcoming')).map(c => c._id);
    assert.ok(ids.includes(futureId));
    assert.ok(!ids.includes(derivedId), 'it is overdue now, and must not surface under its stored status');
    assert.ok(!ids.includes(storedId), 'nor a stored `overdue` under a status it does not have');
  });
});

describe('the status filter survives being combined', () => {
  // The fix needed an `$or`, and `$or` was already taken by the substring search — assigned, not
  // accumulated. Combining them is where an erased clause would show up, as MORE rows rather than an error.
  let match, otherOverdue;

  before(async () => {
    match = await mk('ch1 combo needle overdue', { startsAt: PAST, status: 'upcoming' });
    otherOverdue = await mk('ch1 combo haystack', { startsAt: PAST, status: 'upcoming', tags: ['ch1-combo'] });
  });

  it('status + search applies BOTH', async () => {
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'chrono',
    { search: 'needle', limit: 500, deriveStatus: true, filter: { status: 'overdue' } });
    assert.equal(r.status, 200);
    const ids = r.results.map(c => c._id);
    assert.ok(ids.includes(match), 'the entry matching both must be returned');
    assert.ok(!ids.includes(otherOverdue),
      'an overdue entry that does NOT match the search must be filtered out — if it is here, the search clause was erased');
  });

  it('status + tag applies both', async () => {
    // `tags` was the route's exact-set filter, which is `$all` as a predicate — not the `tag` substring
    // convenience, which would match a different set and make this case pass for the wrong reason.
    const r = await readCollection(INSTANCES.a, tokenA, 'general', 'chrono',
      { limit: 500, deriveStatus: true, filter: { status: 'overdue', tags: { $all: ['ch1-combo'] } } });
    assert.equal(r.status, 200);
    const ids = r.results.map(c => c._id);
    assert.ok(ids.includes(otherOverdue));
    assert.ok(!ids.includes(match), 'the untagged overdue entry must not be here');
  });
});
