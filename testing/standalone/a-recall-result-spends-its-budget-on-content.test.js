/**
 * What a recall answer spends a caller's byte budget on.
 *
 * ## Why this is a gate and not a preference
 *
 * `maxChars` is the caller's contract: it is how much of their context window they are willing to give to
 * memory. Measured on a real corpus, **30% of what came back was content** — 3,314 characters of JSON to
 * carry 986 characters of remembered fact. The rest was the record's place in the store: when it was
 * written, when it was last touched, and the ids of everything it links to.
 *
 * That is not a rounding error at the budgets this competes at. A caller asking for 2,600 characters of
 * memory received about a thousand characters of what they came for, and paid for the rest.
 *
 * ## The two rules, and why only one of them needs a flag
 *
 * **An empty collection is never worth sending.** `"tags":[]` and `"properties":{}` say nothing that their
 * absence does not, and a caller reading `result.tags?.length` cannot tell the difference. No flag: there is
 * no reading under which the empty version is the useful one.
 *
 * **Storage bookkeeping is opt-in.** `createdAt`, `updatedAt` and `entityIds` describe the record rather
 * than what it says — and `createdAt` in particular is routinely mistaken for when the remembered thing
 * happened, which lives in the record's own properties. A caller that needs them asks; the common case,
 * reading memory to answer something, does not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { stripRecordMeta, RECORD_META_KEYS } = await import('../../server/dist/brain/recall-record-meta.js');

/** A memory result shaped the way the REST door flattens one. */
const result = () => ({
  _id: 'm1', spaceId: 's', score: 0.9312, type: 'memory',
  fact: 'Caroline attended an LGBTQ support group on 7 May 2023.',
  properties: { speaker: 'Caroline', statedOn: '2023-05-08' },
  tags: [], entityIds: ['e1', 'e2'],
  createdAt: '2026-09-15T09:00:00.000Z', updatedAt: '2026-09-15T09:00:00.000Z',
});

describe('an empty collection is dropped, always', () => {
  test('an empty tags array goes', () => {
    assert.ok(!('tags' in stripRecordMeta(result(), { includeRecordMeta: true })));
  });

  test('a populated one stays — it is content the caller set', () => {
    const r = { ...result(), tags: ['pinned'] };
    assert.deepEqual(stripRecordMeta(r, { includeRecordMeta: true }).tags, ['pinned']);
  });

  test('an empty properties object goes, a populated one stays', () => {
    assert.ok(!('properties' in stripRecordMeta({ ...result(), properties: {} }, { includeRecordMeta: true })));
    assert.ok('properties' in stripRecordMeta(result(), { includeRecordMeta: true }));
  });
});

describe('storage bookkeeping is opt-in', () => {
  test('by default the record says what it says and not where it sits', () => {
    const out = stripRecordMeta(result(), {});
    for (const k of RECORD_META_KEYS) assert.ok(!(k in out), `${k} survived without being asked for`);
  });

  test('and asking for it gets it back', () => {
    const out = stripRecordMeta(result(), { includeRecordMeta: true });
    assert.equal(out.createdAt, '2026-09-15T09:00:00.000Z');
    assert.deepEqual(out.entityIds, ['e1', 'e2']);
  });

  test('nothing a question is answered from is ever dropped', () => {
    // The floor. A saving that loses the answer is not a saving, and this is the assertion that would fail
    // if somebody later decided `properties` or `score` looked like overhead too.
    const out = stripRecordMeta(result(), {});
    assert.equal(out.fact, 'Caroline attended an LGBTQ support group on 7 May 2023.');
    assert.deepEqual(out.properties, { speaker: 'Caroline', statedOn: '2023-05-08' });
    assert.equal(out._id, 'm1');
    assert.equal(out.score, 0.9312);
    assert.equal(out.type, 'memory');
  });

  test('it is worth doing — the default is materially smaller', () => {
    const before = JSON.stringify(stripRecordMeta(result(), { includeRecordMeta: true })).length;
    const after = JSON.stringify(stripRecordMeta(result(), {})).length;
    assert.ok(after < before * 0.75,
      `the default saves only ${(100 - 100 * after / before).toFixed(0)}% — not worth a behaviour change`);
  });
});

describe('it reaches the whole answer, not the top of it', () => {
  test('a graph expansion is trimmed at every depth', () => {
    // A `traverse` answer is where the bytes actually are, and a rule applied only to the top level would
    // leave the expensive half untouched while the numbers looked better.
    const nested = { ...result(), _graph: [{ edge: { label: 'x' }, node: result(), _graph: [{ node: result() }] }] };
    const out = stripRecordMeta(nested, {});
    assert.ok(!('createdAt' in out._graph[0].node), 'a hop-1 node kept its bookkeeping');
    assert.ok(!('createdAt' in out._graph[0]._graph[0].node), 'a hop-2 node kept its bookkeeping');
  });

  test('the input is not mutated', () => {
    // Results are handed to the audit trail and the duplicate check as well as to the response; deleting a
    // field in place would change what those see.
    const r = result();
    stripRecordMeta(r, {});
    assert.ok('createdAt' in r, 'the caller\'s object was edited underneath them');
  });
});
