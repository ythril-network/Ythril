/**
 * `recall`'s filter accepts the same grammar `query`'s does — including the filter the fleet integrator could not express at all.
 *
 * ## The report
 *
 * The fleet integrator, 2026-08-13T1035Z §2. `recall`'s filter was one operator object per key, ANDed: `eq`, `ne`, `in`, `exists`,
 * `gt`, `gte`, `lt`, `lte`. `query`'s takes `$or`, `$and`, `$not`, `$nor`, `$regex`, `$elemMatch` nested to depth 8. Same
 * store, same policy, **two grammars** — so a caller wanting meaning-ranking AND a real predicate ran `query` first and
 * fed ids into something else.
 *
 * Their case is the mailbox query in this board's own usage notes, and it is the centrepiece assertion below: *a message is
 * ours if `from`, `to` or `alsoFor` names us, and separately our own asks are live while `status` is open.* Not expressible
 * in the old grammar at any length.
 *
 * ## What must NOT change
 *
 * The old grammar keeps working — `{"properties.status": {"eq": "x"}}` is not valid raw Mongo, so a parser swap would have
 * broken every existing caller including our own client. And the KEY allowlist stays, recursively, because widening the
 * grammar is not widening the keys: a recall filter that could name any field would be a way to filter a vector search on
 * fields the index cannot serve.
 *
 * Run: node --test testing/standalone/recall-filter-grammar.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let resolveRecallFilter;

before(async () => {
  ({ resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
});

describe('the grammar the fleet integrator asked for', () => {
  it('accepts their mailbox filter, which the old grammar could not express', () => {
    // Copied from this board's `usageNotes`, with `the fleet integrator` as the party. This is the whole ask.
    const mailbox = {
      type: 'message',
      $or: [
        {
          'properties.from': { $ne: 'the fleet integrator' },
          'properties.readBy': { $ne: 'the fleet integrator' },
          $or: [{ 'properties.to': 'the fleet integrator' }, { 'properties.alsoFor': 'the fleet integrator' }],
        },
        {
          'properties.from': 'the fleet integrator',
          'properties.status': 'open',
          'properties.kind': { $in: ['ask', 'request', 'proposal'] },
        },
      ],
    };
    const r = resolveRecallFilter(mailbox);
    assert.ok(r.ok, `refused: ${r.error}`);
    assert.equal(r.kind, 'mongo', 'a raw filter must be reported as raw, so the caller uses the exhaustive path');
    // WRAPPED in `__raw`, so both grammars can travel in one `filter` parameter rather than two mutually-exclusive ones.
    // That shape exists because the two-parameter version pushed `recall.ts` past the god-file ratchet, and the smaller
    // design turned out to be the better one.
    assert.deepEqual(r.filter.__raw, mailbox, 'an allowlisted raw filter passes through as itself');
  });

  it('accepts $regex, $and and $elemMatch', () => {
    for (const f of [
      { name: { $regex: '^RMA-' } },
      { $and: [{ type: 'message' }, { 'properties.status': 'open' }] },
      { tags: { $elemMatch: { $eq: 'rma' } } },
    ]) {
      assert.ok(resolveRecallFilter(f).ok, `refused ${JSON.stringify(f)}`);
    }
  });
});

describe('the old grammar still works — a parser swap would have broken every caller', () => {
  it('translates the operator-object form', () => {
    const r = resolveRecallFilter({ 'properties.status': { eq: 'accepted' }, 'properties.count': { gt: 10 } });
    assert.ok(r.ok, `refused: ${r.error}`);
    // Reported as an EXPRESSION and handed back untouched, so the native pre-filter path stays available. Translating
    // it here would have silently moved every existing caller onto the exhaustive path — a performance regression
    // delivered as a refactor.
    assert.equal(r.kind, 'expression');
    assert.deepEqual(r.expression, { 'properties.status': { eq: 'accepted' }, 'properties.count': { gt: 10 } });
  });

  it('ACCEPTS a field the old allowlist refused, in either grammar', () => {
    /*
     * This asserted the refusal. The field allowlist was removed on 2026-09-17 because it was a SPEED rule
     * wearing a safety label: a key outside `properties.*`/`tags`/`type`/`name`/`status`/`label` takes the
     * exhaustive path, which is slower and equally correct — and refusing it made the capability absent on
     * `recall` while `filter` accepted the same predicate through the other door. Owner: *"they need to be
     * the same."*
     *
     * Flipped rather than deleted, because the acceptance is the thing worth holding: restoring the
     * allowlist would break the parity this change exists for, and a deleted case says nothing about that.
     */
    const legacy = resolveRecallFilter({ secretField: { eq: 'x' } });
    assert.ok(legacy.ok, `the operator-object grammar refused a plain field: ${legacy.error}`);
    assert.equal(legacy.kind, 'expression');

    const raw = resolveRecallFilter({ description: { $regex: 'platform' } });
    assert.ok(raw.ok, `raw Mongo refused a plain field: ${raw.error}`);
    assert.equal(raw.kind, 'mongo');
  });

  it('treats no filter and an empty filter as unfiltered', () => {
    for (const f of [undefined, null, {}]) {
      const r = resolveRecallFilter(f);
      assert.ok(r.ok);
      assert.equal(r.kind, 'none', `${JSON.stringify(f)} must mean "no filter", not "match nothing"`);
    }
  });
});

describe('what the widening did NOT open, at every depth', () => {
  /*
   * THE KEY ALLOWLIST IS GONE and these cases were rewritten rather than deleted.
   *
   * They asserted that an undeclared field was refused inside `$or` — *"the smuggling route"*. There is
   * nothing to smuggle any more: an unusual field is slow, not unsafe, and the response says so with
   * `filterPath: 'exhaustive'` instead of refusing the query.
   *
   * What the recursion still has to catch is the shape that cannot be a field at all, and it has to catch
   * it at depth for the same reason the old rule did — a nested clause is exactly where a caller would put
   * something the top-level scan would miss.
   */
  it('accepts an arbitrary field nested inside $or, and says it will scan', () => {
    const r = resolveRecallFilter({ $or: [{ type: 'message' }, { embedding: { $exists: true } }] });
    assert.ok(r.ok, `a plain field inside $or was refused: ${r.error}`);
    assert.equal(r.kind, 'mongo');
  });

  it('but still refuses a JavaScript operator nested inside $or', () => {
    const r = resolveRecallFilter({ $or: [{ type: 'message' }, { $where: 'this.x' }] });
    assert.ok(!r.ok, 'an operator that executes code must be refused at any depth');
    assert.match(r.error, /\$where/);
  });

  it('and a prototype-shaped key nested inside $or', () => {
    // A computed key: written literally, `__proto__:` sets the prototype and `Object.keys` never sees it,
    // so the case would pass without the guard existing.
    const r = resolveRecallFilter({ $or: [{ type: 'message' }, { ['__proto__']: 1 }] });
    assert.ok(!r.ok, 'a key that rewrites the filter object must be refused at any depth');
    assert.match(r.error, /__proto__/);
  });

  it('every field the old allowlist named still works, at depth', () => {
    const r = resolveRecallFilter({
      $or: [{ tags: 'rma' }, { 'properties.a.b': 1 }, { name: 'x' }, { status: 'open' }, { label: 'l' }, { type: 't' }],
    });
    assert.ok(r.ok, `refused: ${r.error}`);
  });
});

describe('a MIXED filter is refused, not resolved', () => {
  it('names both sides rather than guessing which one wins', () => {
    // A caller who believes one thing and would get another. One round trip beats a wrong answer.
    const r = resolveRecallFilter({ $or: [{ type: 'a' }], 'properties.status': { eq: 'open' } });
    assert.ok(!r.ok);
    assert.match(r.error, /mixes both grammars/);
    assert.match(r.error, /properties\.status/, 'the offending key must be named');
  });

  it('does not mistake a legitimate raw value-object for the old grammar', () => {
    // `{$in: [...]}` is raw Mongo, not the operator-object form. Confusing the two would refuse valid filters.
    const r = resolveRecallFilter({ $or: [{ type: 'a' }], 'properties.kind': { $in: ['ask'] } });
    assert.ok(r.ok, `a raw value-object was mistaken for the old grammar: ${r.error}`);
  });
});

describe('it inherits query\'s refusals rather than reimplementing them', () => {
  it('rejects an operator outside the allowlist, with query\'s own message', () => {
    const r = resolveRecallFilter({ $where: 'this.x' });
    assert.ok(!r.ok, '$where must be refused');
  });

  it('rejects excessive nesting', () => {
    let deep = { type: 'x' };
    for (let i = 0; i < 12; i++) deep = { $and: [deep] };
    assert.ok(!resolveRecallFilter(deep).ok, 'depth must be capped as it is for query');
  });

  it('rejects a non-object filter instead of coercing it', () => {
    for (const bad of ['string', 42, [1, 2]]) {
      const r = resolveRecallFilter(bad);
      assert.ok(!r.ok, `${JSON.stringify(bad)} was accepted`);
    }
  });
});
