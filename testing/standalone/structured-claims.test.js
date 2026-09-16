/**
 * What a record CLAIMS, for the structured contradiction judge.
 *
 * Two things are pinned here, and both are decisions rather than mechanics:
 *
 *  1. **Chrono's `status` counts as a claim.** It lives in a top-level column, not in `properties`, so
 *     without this the structured judge had nothing to compare on a chrono pair and could only ever answer
 *     "no structured conflict" — a sweep that runs, reports success, and finds nothing by construction.
 *
 *  2. **Chrono's DATES deliberately do not.** `startsAt`/`endsAt` are not embedded, so two hand-logged
 *     occurrences of a repeating event ("Team sync", every Monday) pair at ~1.0 similarity with different
 *     dates every single time. Reporting those would fill the review queue with the one thing that is
 *     definitely not a contradiction. The test asserts their ABSENCE so that "completing" the field list
 *     is a conscious act with a failing test in front of it, not a tidy-up.
 *
 * Run: node --test testing/standalone/structured-claims.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let structuredClaims, extraClaimFields, findPropertyDisagreements;

describe('structured claims', () => {
  before(async () => {
    ({ structuredClaims, extraClaimFields } = await import('../../server/dist/brain/structured-claims.js'));
    ({ findPropertyDisagreements } = await import('../../server/dist/brain/contradiction-judge.js'));
  });

  it('counts a chrono entry\'s status as a claim, alongside its properties', () => {
    const claims = structuredClaims('chrono', { status: 'completed', properties: { venue: 'oslo' } });
    assert.deepEqual(claims, { venue: 'oslo', status: 'completed' });
  });

  it('does NOT count the chrono dates — two occurrences of a repeating event are not a contradiction', () => {
    const fields = extraClaimFields('chrono');
    assert.ok(!fields.includes('startsAt'), 'startsAt must stay out: see the module note');
    assert.ok(!fields.includes('endsAt'), 'endsAt must stay out: see the module note');
    // And it must not leak in through the claim map either.
    const claims = structuredClaims('chrono', { status: 'upcoming', startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-01-02T00:00:00Z' });
    assert.deepEqual(Object.keys(claims).sort(), ['status']);
  });

  it('leaves types with no extra columns exactly as they were', () => {
    // Memory and entity claim only through `properties`; this must stay a pass-through so the write path
    // and the sweep keep judging them identically to before.
    assert.equal(extraClaimFields('fact').length, 0);
    const props = { port: 8080 };
    assert.equal(structuredClaims('fact', { properties: props }), props);
    assert.equal(structuredClaims('entity', { properties: undefined }), undefined);
  });

  it('lets the stored column win over a same-named property', () => {
    // The column is what the rest of the system reads and writes; a stray property shadowing it would make
    // the judge rule on a value nothing else honours.
    const claims = structuredClaims('chrono', { status: 'cancelled', properties: { status: 'upcoming' } });
    assert.equal(claims.status, 'cancelled');
  });

  it('makes two chrono entries that disagree about status a structured contradiction', () => {
    // The end-to-end point of the module: same event, two claims about what became of it.
    const a = structuredClaims('chrono', { status: 'completed' });
    const b = structuredClaims('chrono', { status: 'cancelled' });
    const d = findPropertyDisagreements({ id: 'a', text: '', properties: a }, { id: 'b', text: '', properties: b });
    assert.equal(d.length, 1);
    assert.deepEqual(d[0], { key: 'status', aValue: 'completed', bValue: 'cancelled' });
  });

  it('says nothing when they agree about status', () => {
    const a = structuredClaims('chrono', { status: 'upcoming' });
    const b = structuredClaims('chrono', { status: 'upcoming' });
    assert.deepEqual(findPropertyDisagreements({ id: 'a', text: '', properties: a }, { id: 'b', text: '', properties: b }), []);
  });
});
