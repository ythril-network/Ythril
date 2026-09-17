/**
 * `listChrono`'s filter finds every overdue entry, and no clause silently erases another.
 *
 * ## CH-1 — the entries a caller marked were invisible to the filter that names them
 *
 * `overdue` is DERIVED on read (C5): an entry stored `upcoming`/`active` whose due moment has passed is
 * returned as `overdue`. The list filter was translated to match that — and ONLY that:
 *
 * ```js
 * query['status'] = { $in: ['upcoming', 'active'] };
 * query['$expr']  = { $lt: [refDate, now] };
 * ```
 *
 * But `overdue` is a legal STORED value on every write door — the enum accepts it on `save_chrono`,
 * `update_chrono`, `save_bulk`, both REST routes, and the Brain UI's own status dropdown — and
 * `deriveChronoStatus` passes a stored one straight through. So `status: "overdue"` returned the entries
 * nobody had touched and hid the ones somebody had deliberately marked. Backwards.
 *
 * ## Why the fix needed an accumulator rather than one more clause
 *
 * Matching both kinds needs an `$or`. `query['$or']` was already taken — by the substring search, assigned
 * with `=` at the bottom of the same function — and `query['$and']` was taken by the tag pair, also with
 * `=`. Three filters, two keys, three assignments. Adding a fourth writer would have made
 * `status: "overdue"` plus `search: "…"` drop one of the two constraints, silently and in the WIDENING
 * direction.
 *
 * So compound clauses accumulate into one `$and` array. The point of these tests is less the `overdue` fix
 * than that combinations survive: an erased clause throws nothing, logs nothing, and returns MORE rows.
 *
 * ## Exercised, not grepped
 *
 * `buildChronoQuery` was extracted for this — it is pure, so these are real calls with real verdicts and no
 * Docker. A source-reading test could not tell a clause that is built from one that is then overwritten.
 *
 * Run: node --test testing/standalone/chrono-list-filter-composes.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let buildChronoQuery, deriveChronoStatus;
before(async () => {
  ({ buildChronoQuery } = await import('../../server/dist/brain/chrono.js'));
  ({ deriveChronoStatus } = await import('../../server/dist/brain/chrono-status.js'));
});

const NOW = new Date('2026-08-16T12:00:00Z');
const build = (filter) => buildChronoQuery('s1', filter, NOW);

/** Every branch of an `$and` accumulator, flattened, so a test can ask "is this constraint still here". */
const clauses = (query) => [query, ...(query['$and'] ?? [])];
const someClause = (query, pred) => clauses(query).some(pred);

describe('status: overdue matches BOTH kinds', () => {
  it('the derived ones — stored upcoming/active, past due', () => {
    const { query } = build({ status: 'overdue' });
    const or = query['$and'][0]['$or'];
    const derived = or.find(b => b['status']?.['$in']);
    assert.deepEqual(derived['status']['$in'], ['upcoming', 'active']);
    assert.ok(derived['$expr']['$lt'], 'compared against the clock, less-than the due moment');
  });

  it('AND an entry a caller stored as overdue — the half that was missing', () => {
    const { query } = build({ status: 'overdue' });
    const or = query['$and'][0]['$or'];
    assert.ok(or.some(b => b['status'] === 'overdue'),
      'the enum accepts `overdue` on every write door, so a stored one must be findable');
  });

  it('and the stored one is consistent with what the derivation returns for it', () => {
    // If `deriveChronoStatus` ever stopped passing a stored `overdue` through, matching it here would
    // return rows the caller then sees under a different status.
    assert.equal(deriveChronoStatus({ status: 'overdue', startsAt: '2027-01-01T00:00:00Z' }, NOW), 'overdue');
  });
});

describe('the other status branches are unchanged', () => {
  it('upcoming and active still EXCLUDE the now-overdue ones', () => {
    for (const s of ['upcoming', 'active']) {
      const { query } = build({ status: s });
      assert.equal(query['status'], s);
      assert.ok(query['$expr']['$gte'], `${s} must exclude entries whose due moment has passed`);
    }
  });

  it('completed and cancelled are plain matches with no clock in them', () => {
    // set-claim: a deliberate SUBSET, not a set -- the two statuses with no clock in them, contrasted
    // with the clocked ones in the case above. Naming all five here would assert the opposite rule.
    for (const s of ['completed', 'cancelled']) {
      const { query, comparesAgainstTheClock } = build({ status: s });
      assert.equal(query['status'], s);
      assert.equal(query['$expr'], undefined, 'nothing to derive');
      assert.equal(comparesAgainstTheClock, false);
    }
  });
});

describe('the scan budget follows the DECISION, not the query shape', () => {
  /**
   * `listChrono` chose its `maxTimeMS` by asking `query['$expr'] ? SHORT : 60_000`. Moving the `overdue`
   * comparison inside an `$or` removes that top-level key while the per-document evaluation stays — so the
   * budget would have quietly gone back to 60 s on the one filter that got MORE expensive. A guard on the
   * wrong axis: it read the shape instead of the reason.
   */
  it('overdue compares against the clock even though $expr is no longer top-level', () => {
    const { query, comparesAgainstTheClock } = build({ status: 'overdue' });
    assert.equal(query['$expr'], undefined, 'it lives inside the $or now — this is the trap');
    assert.equal(comparesAgainstTheClock, true, 'and the budget must still know that');
  });

  it('upcoming/active too', () => {
    assert.equal(build({ status: 'active' }).comparesAgainstTheClock, true);
  });

  it('and a filter with no status does not pay for a scan', () => {
    assert.equal(build({ search: 'x' }).comparesAgainstTheClock, false);
    assert.equal(build({}).comparesAgainstTheClock, false);
  });
});

describe('no clause erases another', () => {
  it('status + search keeps both — the collision the fix would have introduced', () => {
    const { query } = build({ status: 'overdue', search: 'launch' });
    assert.ok(someClause(query, c => c['$or']?.some(b => b['status'] === 'overdue')),
      'the status disjunction survived');
    assert.ok(someClause(query, c => c['$or']?.some(b => b['title'] ?? b['description'])),
      'and so did the substring search');
    assert.equal(query['$and'].length, 2, 'two independent constraints, ANDed');
  });

  it('tags + tagsAny + search keeps all three', () => {
    const { query } = build({ tags: ['a'], tagsAny: ['b', 'c'], search: 'x' });
    assert.ok(someClause(query, c => c['tags']?.['$all']), '$all survived');
    assert.ok(someClause(query, c => c['tags']?.['$in']), '$in survived');
    assert.ok(someClause(query, c => c['$or']), 'search survived');
    assert.equal(query['tags'], undefined, 'and the bare key was cleared, not left contradicting the pair');
  });

  it('all four at once', () => {
    const { query } = build({ status: 'overdue', tags: ['a'], tagsAny: ['b'], search: 'x' });
    assert.equal(query['$and'].length, 4, 'status, $all, $in, search — none dropped');
  });

  it('nothing ever assigns a bare top-level $or', () => {
    // The erasure was possible because two writers shared one key. Nothing may write it directly again.
    for (const f of [{ search: 'x' }, { status: 'overdue' }, { status: 'overdue', search: 'x' }]) {
      assert.equal(build(f).query['$or'], undefined,
        `\`${JSON.stringify(f)}\` put an $or at the top level, where the next writer would overwrite it`);
    }
  });

  it('and a simple filter stays simple — no empty $and', () => {
    const { query } = build({ type: 'deadline' });
    assert.equal(query['$and'], undefined, 'an accumulator that always fires makes every query harder to read');
    assert.equal(query['type'], 'deadline');
  });
});

describe('the unrelated filters still land', () => {
  it('space, type, date range and the single-tag box', () => {
    const { query } = build({ type: 'event', after: '2026-01-01', before: '2026-12-31', tagLike: 'rel' });
    assert.equal(query['spaceId'], 's1');
    assert.equal(query['type'], 'event');
    assert.equal(query['createdAt']['$gt'], '2026-01-01');
    assert.equal(query['createdAt']['$lt'], '2026-12-31');
    /*
     * The substring tag box narrows `tags`, and since the conveniences moved into
     * `conveniencePredicate` it does so as a clause under `$and` rather than as a bare key — the module
     * accumulates so that two conveniences, or a caller's own `$or`, cannot overwrite each other.
     * Asserted wherever it lands: the rule is that the box narrows tags, not which key holds it.
     */
    assert.match(JSON.stringify(query), /"tags":\{"\$regex":"rel"/,
      `the substring tag box did not narrow tags: ${JSON.stringify(query)}`);
  });

  it('tagsAny alone stays a bare $in rather than a one-element $and', () => {
    const { query } = build({ tagsAny: ['b'] });
    assert.deepEqual(query['tags'], { $in: ['b'] });
    assert.equal(query['$and'], undefined);
  });
});
