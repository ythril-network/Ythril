/**
 * Two untested modules, both of them guards.
 *
 * From the QA tracker's "production modules with no importing test" list. Not a sweep — these two are
 * here because both are *guards*, and a guard with no test is indistinguishable from a guard that has
 * quietly stopped guarding.
 *
 *  - `brain/filter.ts` decides which filter keys can never be fields at all. It stopped being a FIELD
 *    allowlist on 2026-09-17 — that was a speed rule wearing a safety label, and it made `recall` refuse
 *    predicates `filter` accepted. What it still stands between is a user-supplied key and an object
 *    assignment that would rewrite the filter rather than add a constraint to it.
 *  - `util/seq.ts` decides which `seq` values may be ingested from a peer. It exists to stop one hostile
 *    or broken document from stranding a space's counter near the protocol ceiling, after which every
 *    local write is rejected by every peer — silent, unrecoverable write loss.
 *
 * Run: node --test testing/standalone/filter-and-seq-guards.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let validateFilterExpression, buildMongoFilter;
let isSeqImplausible, MAX_INGEST_SEQ, MAX_SYNC_SEQ, SEQ_CEILING_RESERVE;

before(async () => {
  ({ validateFilterExpression, buildMongoFilter } =
    await import('../../server/dist/brain/filter.js'));
  ({ isSeqImplausible, MAX_INGEST_SEQ, MAX_SYNC_SEQ, SEQ_CEILING_RESERVE } =
    await import('../../server/dist/util/seq.js'));
});

const ok = f => assert.equal(validateFilterExpression(f), null);
const rejected = f => assert.match(validateFilterExpression(f) ?? '', /not allowed/);

describe('filter key shape — what a caller may never filter on', () => {
  /*
   * THE FIELD ALLOWLIST IS GONE, and the cases that asserted it went with it rather than being weakened.
   *
   * `validateFilterExpression` used to refuse any key outside `properties.*`, `tags`, `type`, `name`,
   * `status` and `label`. That was a SPEED rule wearing a safety label: a key outside the set takes the
   * exhaustive path, which is slower and equally correct, and refusing it made the capability absent on
   * `recall` while `filter` accepted the same predicate. Owner, 2026-09-17: *"same for the recall with
   * filter … they need to be the same."*
   *
   * What stays is the shape that cannot be a field at all. Keeping the old cases and merely deleting the
   * ones that turned red would have left a gate whose title still said "allowlist" over a body checking
   * something else — which is the failure `CLAUDE.md` gives its own section to.
   */
  it('accepts a field the old allowlist refused', () => {
    // The capability the removal was for. `description` is a real field on every record type, and it was
    // refused here while `filter` accepted it — one rule, two implementations, the weaker one winning.
    ok({ description: { eq: 'x' } });
    ok({ fact: { eq: 'x' } });
    ok({ 'properties.owner': { eq: 'x' } });
    ok({ 'anything.at.all': { eq: 'x' } });
  });

  it('refuses the three keys that would change the filter instead of constraining it', () => {
    /*
     * Not fields — the names that make `out[key] = …` do something other than add a key. Handed
     * `__proto__`, a plain-object assignment sets the PROTOTYPE, so the constraint never reaches the
     * database and the query answers 200 over an unfiltered collection.
     *
     * The distinction from the removed allowlist is the whole point of this case: an unusual FIELD is
     * slow, and one of these is silently absent.
     */
    for (const k of ['__proto__', 'constructor', 'prototype']) rejected({ [k]: { eq: 1 } });
  });

  it('refuses a Mongo operator in the operator-object grammar', () => {
    /*
     * `{$where: {eq: 'x'}}` is a caller writing raw MongoDB into the old grammar, and it used to build
     * `{$where: {$eq: 'x'}}` and hand it to the database — the expression path has no `sanitizeFilter`
     * between it and Mongo, so the operator that executes JavaScript arrived unexamined.
     *
     * `grammarOf` routes anything `$`-prefixed to the raw path now, where that sanitizer lives. This is
     * the floor under that, so a change to the classifier cannot reopen the hole on its own.
     */
    for (const k of ['$where', '$or', '$and', '$expr', '$function', '$nor']) {
      rejected({ [k]: { eq: 1 } });
    }
  });

  it('refuses the whole expression if ANY key is refused', () => {
    rejected({ tags: { eq: 'a' }, $where: { eq: 'b' } });
    /*
     * A COMPUTED key, and it has to be. Written literally as `__proto__:` in an object literal, JavaScript
     * sets the prototype instead of creating a property — so `Object.keys` never sees it and the case
     * would pass without the guard existing. The first version of this line did exactly that.
     */
    rejected({ tags: { eq: 'a' }, ['__proto__']: { eq: 'b' } });
  });

  it('an empty expression is valid and constrains nothing', () => {
    ok({});
    assert.deepEqual(buildMongoFilter({}), {});
  });
});

describe('buildMongoFilter — falsy values are values', () => {
  it('maps every supported operator', () => {
    assert.deepEqual(
      buildMongoFilter({ 'properties.n': { gt: 1, gte: 2, lt: 3, lte: 4, ne: 5 } }),
      { 'properties.n': { $gt: 1, $gte: 2, $lt: 3, $lte: 4, $ne: 5 } },
    );
    assert.deepEqual(buildMongoFilter({ tags: { in: ['a', 'b'] } }), { tags: { $in: ['a', 'b'] } });
  });

  it('keeps `exists: false`', () => {
    // The classic bug: a truthiness check here silently turns "this field must be ABSENT" into no
    // constraint at all, which widens the result set instead of narrowing it. Same for eq below.
    assert.deepEqual(buildMongoFilter({ 'properties.x': { exists: false } }),
      { 'properties.x': { $exists: false } });
  });

  it('keeps `eq: 0`, `eq: false` and `eq: ""`', () => {
    assert.deepEqual(buildMongoFilter({ 'properties.n': { eq: 0 } }), { 'properties.n': { $eq: 0 } });
    assert.deepEqual(buildMongoFilter({ 'properties.b': { eq: false } }), { 'properties.b': { $eq: false } });
    assert.deepEqual(buildMongoFilter({ 'properties.s': { eq: '' } }), { 'properties.s': { $eq: '' } });
  });

  it('drops a key whose operator object is empty rather than emitting a match-anything clause', () => {
    assert.deepEqual(buildMongoFilter({ tags: {} }), {});
  });

  it('never emits a key the caller did not supply', () => {
    const out = buildMongoFilter({ tags: { eq: 'a' } });
    assert.deepEqual(Object.keys(out), ['tags']);
  });
});

describe('seq ingest guard — the sync-poisoning ceiling', () => {
  it('the reserve leaves real headroom below the protocol ceiling', () => {
    assert.equal(MAX_INGEST_SEQ, MAX_SYNC_SEQ - SEQ_CEILING_RESERVE);
    assert.ok(SEQ_CEILING_RESERVE > 0 && SEQ_CEILING_RESERVE < MAX_SYNC_SEQ);
  });

  it('accepts ordinary counter values', () => {
    for (const s of [0, 1, 42, 1_000_000, MAX_INGEST_SEQ]) {
      assert.equal(isSeqImplausible(s), false, `${s} should be ingestible`);
    }
  });

  it('rejects a value near the ceiling — the poisoning case', () => {
    // One document carrying this drags the space counter up via bumpSeq, and every subsequent LOCAL
    // write then exceeds what peers accept. The loss is silent and unrecoverable, which is why the
    // guard is absolute rather than relative to the current counter.
    assert.equal(isSeqImplausible(MAX_INGEST_SEQ + 1), true);
    assert.equal(isSeqImplausible(MAX_SYNC_SEQ), true);
    assert.equal(isSeqImplausible(MAX_SYNC_SEQ * 2), true);
  });

  it('rejects negatives and non-finite values', () => {
    for (const s of [-1, -0.5, NaN, Infinity, -Infinity]) {
      assert.equal(isSeqImplausible(s), true, `${s} should be refused`);
    }
  });
});

/**
 * A VALUE the sanitiser does not recognise must survive, or be refused — never be rewritten.
 *
 * Found 2026-09-18 by a server-built predicate. `B-19` puts `$gte: [<dueMoment>, now]` into a chrono
 * filter so `status: "active"` excludes what is derived-overdue. `Object.entries(new Date())` is empty,
 * so the walk rebuilt `now` key by key and produced `{}` — the comparison then matched every stored
 * active entry, overdue or not, and answered 200.
 *
 * **No caller could have hit it, which is why it survived.** A filter arriving over HTTP is JSON, so its
 * dates are strings. It bites the moment a predicate is built in-process, and this module is on the path
 * of every one of those.
 *
 * The rule the case stands for is the module's own subject read one level up: everything else here
 * THROWS on something it will not accept, and this one quietly returned a different value.
 */
describe('the sanitiser does not rewrite a value it cannot decompose', () => {
  let sanitizeFilter;
  before(async () => {
    ({ sanitizeFilter } = await import('../../server/dist/brain/filter-sanitizer.js'));
  });

  it('a Date survives as a Date, not as an empty object', () => {
    const now = new Date('2026-09-18T00:00:00.000Z');
    const out = sanitizeFilter({ startsAt: { $gte: now } });
    const kept = out.startsAt.$gte;
    assert.ok(kept instanceof Date, `a Date became ${JSON.stringify(kept)} — the comparison is now meaningless`);
    assert.equal(kept.getTime(), now.getTime());
  });

  it('including one nested inside an $expr, which is where it was found', () => {
    // The shape `B-19` builds. A flattened `now` here does not error: it matches the wrong set.
    const now = new Date('2026-09-18T00:00:00.000Z');
    const out = sanitizeFilter({ $expr: { $gte: [{ $toDate: '$startsAt' }, now] } });
    assert.ok(out.$expr.$gte[1] instanceof Date, 'the clock was flattened inside the $expr');
  });

  it('and the same Date is still refused where the rules refuse it', () => {
    // Preserving a value must not become a way around the guards: a Date as a `$regex` is still not a
    // string pattern, and `__proto__` is still a key that names an object's internals.
    assert.throws(() => sanitizeFilter({ name: { $regex: new Date() } }), /\$regex/);
    // A COMPUTED key: `{ __proto__: … }` in a literal sets the prototype instead of creating the own
    // property the guard is about, so the literal form would assert nothing at all.
    assert.throws(() => sanitizeFilter({ ['__proto__']: { $eq: new Date() } }), /not allowed|internals/);
  });
});
