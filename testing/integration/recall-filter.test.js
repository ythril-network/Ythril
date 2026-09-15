/**
 * Integration tests: Prefiltered semantic recall
 *
 * Covers:
 *  - recall with filter returns only matching records (eq on properties.status)
 *  - high-similarity record with non-matching filter value is excluded
 *  - numeric comparison (gt) filter works
 *  - tags in-filter returns any-of match
 *  - type and name filter keys are allowed
 *  - invalid filter key (not starting with properties./tags/type/name) returns 400
 *  - existing recall without filter is unaffected (backward compat)
 *  - MCP recall tool accepts filter argument and applies it
 *
 * Run: node --test testing/integration/recall-filter.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, waitForIndexed as waitForIndexedShared } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `filter-test-${RUN}`;

let tokenA;
let embeddingAvailable = false;

function token() { return tokenA; }

async function ensureReindexed(baseUrl, tok) {
  const { body: spacesBody } = await get(baseUrl, tok, '/api/spaces');
  const spaces = spacesBody?.spaces ?? [];
  for (const space of spaces) {
    const { body: statusBody } = await get(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex-status`);
    if (statusBody?.needsReindex) {
      await post(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex`, {});
    }
  }
}

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // Create dedicated space for isolation
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Filter Test ${RUN}` });
  assert.equal(r.status, 201, `Failed to create space: ${JSON.stringify(r.body)}`);
  await ensureReindexed(INSTANCES.a, token());
  // Probe embedding availability by writing one entity and checking it gets embedded
  const probe = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `__filter-probe-${RUN}__`,
    type: 'probe',
    description: `filter probe entity ${RUN}`,
    properties: { status: 'probe' },
    tags: [],
  });
  embeddingAvailable = probe.status === 201;
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

/**
 * Wait for $vectorSearch to see the given ids in THIS suite's space.
 *
 * The poll and its deadline live in `helpers.js` — this file used to carry its own copy with a 30 s timeout,
 * which is well under the 150 s index lag observed on CI and failed the whole suite from a `before` hook.
 */
const waitForIndexed = (ids, types = ['entity', 'memory'], timeoutMs) =>
  waitForIndexedIn(SPACE, ids, types, timeoutMs);

// ── Validation tests (no embedding required) ─────────────────────────────

describe('Recall maxPerType — input validation over REST', () => {
  // The REST half of the ceiling's validation. No embedding needed: every case below is refused before the
  // vector search runs, which is the point — a contradictory or nonsensical ceiling must not reach the store.
  // The MCP half is covered in mcp-tools.test.js; both surfaces enforce the same rules, because a rule that
  // reaches one door and not the other is the defect the last brain-API sweep was.

  it('a non-object maxPerType returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxPerType: 3,
    }) });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a non-integer ceiling returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxPerType: { entity: 1.5 },
    }) });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a ceiling of 0 returns 400 and points at `types`', async () => {
    // Deliberate: 0 would work, and it would be a second confusing way to spell "not this type".
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxPerType: { entity: 0 },
    }) });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /types/, `the error should point at \`types\`: ${r.body.error}`);
  });

  it('minPerType above maxPerType for the same type returns 400 naming both values', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', minPerType: { entity: 5 }, maxPerType: { entity: 2 },
    }) });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /contradict/, `the error should name the contradiction: ${r.body.error}`);
    assert.match(r.body.error, /5/, 'the error should quote the floor');
    assert.match(r.body.error, /2/, 'the error should quote the ceiling');
  });

  it('a floor EQUAL to its ceiling is accepted — the tightest legal pair', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', minPerType: { entity: 2 }, maxPerType: { entity: 2 },
    }) });
    assert.notEqual(r.status, 400, `min == max must be allowed: ${JSON.stringify(r.body)}`);
  });

  it('floors and ceilings on DIFFERENT types never contradict', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', minPerType: { entity: 3 }, maxPerType: { file: 1 },
    }) });
    assert.notEqual(r.status, 400, `unrelated types must not be compared: ${JSON.stringify(r.body)}`);
  });
});

describe('Recall maxTimeMS — the per-call deadline over REST', () => {
  /** The closed set of degradation reasons. An unknown value here means the metric label set drifted too. */
  const KNOWN_REASONS = new Set(['search_timeout', 'rerank_skipped_budget', 'rerank_unavailable']);

  it('a non-integer maxTimeMS returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxTimeMS: 12.5,
    }) });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a zero or negative maxTimeMS returns 400', async () => {
    for (const v of [0, -1]) {
      const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
        query: 'test', maxTimeMS: v,
      }) });
      assert.equal(r.status, 400, `Expected 400 for maxTimeMS=${v}, got ${r.status}`);
    }
  });

  it('a value ABOVE the instance budget is clamped, not refused', async () => {
    // A caller asking for longer than the operator allows means "as long as you allow". Refusing would
    // teach them nothing and break a reasonable request.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxTimeMS: 999_999,
    }) });
    assert.notEqual(r.status, 400, `a large maxTimeMS must be clamped: ${JSON.stringify(r.body)}`);
  });

  it('a tiny deadline returns a well-formed 200 rather than hanging or erroring', async () => {
    // Deliberately NOT asserting that `degraded` is present: against a fast local Mongo the searches may
    // finish inside the 250 ms floor, and an assertion that depends on losing a race is a flake. What is
    // asserted is the contract that holds either way — a 200, a results array, and if the flag IS there,
    // only reasons from the closed set.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test', maxTimeMS: 1,
    }) });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.results), 'results must be an array even on a partial answer');
    if (r.body.degraded !== undefined) {
      assert.ok(Array.isArray(r.body.degraded), 'degraded must be an array when present');
      for (const reason of r.body.degraded) {
        assert.ok(KNOWN_REASONS.has(reason), `unknown degraded reason "${reason}"`);
      }
    }
  });

  it('a normal recall carries NO degraded key', async () => {
    // The field's value is in its absence: an empty array on every healthy response is one readers skip.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: 'test' }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal('degraded' in r.body, false, `a healthy recall must omit the key: ${JSON.stringify(r.body)}`);
  });
});

describe('Recall filter — input validation', () => {
  it('filter key not starting with properties./tags/type/name returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'injected.key': { eq: 'value' } },
    }) });
    assert.equal(r.status, 400, `Expected 400 for invalid filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, 'Response must have error field');
  });

  it('filter key with arbitrary top-level field returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'spaceId': { eq: 'anything' } },
    }) });
    assert.equal(r.status, 400, `Expected 400 for disallowed top-level key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter key with _id injection attempt returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { '_id': { eq: 'anything' } },
    }) });
    assert.equal(r.status, 400, `Expected 400 for _id filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter: non-object body returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: 'not-an-object',
    }) });
    assert.equal(r.status, 400, `Expected 400 for non-object filter, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('filter: array body returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: [{ 'properties.status': { eq: 'x' } }],
    }) });
    assert.equal(r.status, 400, `Expected 400 for array filter, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key properties.* passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'properties.status': { eq: 'nonexistent-value-xyzzy' } },
    }) });
    assert.equal(r.status, 200, `Expected 200 for valid filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "type" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'type': { eq: 'entity' } },
    }) });
    assert.equal(r.status, 200, `Expected 200 for type filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "name" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'name': { eq: 'nonexistent-xyzzy' } },
    }) });
    assert.equal(r.status, 200, `Expected 200 for name filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('allowed key "tags" passes validation (200)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test',
      filter: { 'tags': { in: ['nonexistent-tag-xyzzy'] } },
    }) });
    assert.equal(r.status, 200, `Expected 200 for tags filter key, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('recall without filter returns 200 (backward compat)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'test query',
      types: ['entity'],
    }) });
    assert.equal(r.status, 200, `Expected 200 without filter, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.results), 'results must be an array');
  });
});

// ── Semantic filter correctness tests (embedding required) ────────────────

describe('Recall filter — eq filter on properties.status', () => {
  const sharedDesc = `architecture-decision-record-auth-security-${RUN}`;
  let acceptedId;
  let rejectedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    // Write two entities with identical description (→ identical similarity score)
    // but different properties.status — the filter must distinguish them
    const acc = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `ADR-accepted-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'accepted', domain: 'security' },
      tags: ['adr', 'auth'],
    });
    assert.equal(acc.status, 201, `Create accepted entity failed: ${JSON.stringify(acc.body)}`);
    acceptedId = acc.body._id;

    const rej = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `ADR-rejected-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'rejected', domain: 'security' },
      tags: ['adr', 'auth'],
    });
    assert.equal(rej.status, 201, `Create rejected entity failed: ${JSON.stringify(rej.body)}`);
    rejectedId = rej.body._id;

    await waitForIndexed([acceptedId, rejectedId], ['entity']);
  });

  it('filter eq accepted — accepted entity appears, rejected does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'accepted' } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity (${acceptedId}) must be in results`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity (${rejectedId}) must NOT be in filtered results`);
  });

  it('RAW MongoDB $or reaches both — the filter the fleet integrator could not express at all', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    // the fleet integrator 2026-08-13T1035Z §2: recall's grammar was one operator object per key, ANDed, so a predicate with an OR was
    // not expressible at any length and they ran `query` first and fed ids into something else.
    //
    // Both fixtures share an identical description, so similarity cannot distinguish them — only the filter can. An `$or`
    // over both statuses must return BOTH, which the old grammar could not ask for.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { $or: [{ 'properties.status': 'accepted' }, { 'properties.status': 'rejected' }] },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `$or must reach the accepted entity: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(rejectedId), `$or must reach the rejected entity too: ${JSON.stringify(ids)}`);
  });

  it('RAW MongoDB still FILTERS — an $or naming one status excludes the other', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    // The half that matters more: accepting the grammar is worthless if it is then ignored. A filtered search that
    // returns everything is the defect class this whole change came out of.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { $or: [{ 'properties.status': 'accepted' }] },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), 'the named status must be reached');
    assert.ok(!ids.includes(rejectedId),
      `the unnamed status must be excluded — a raw filter that is accepted and ignored is worse than one refused: ${JSON.stringify(ids)}`);
  });

  it('refuses a filter that MIXES the two grammars rather than guessing', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      filter: { $or: [{ 'properties.status': 'accepted' }], 'properties.domain': { eq: 'security' } },
    }) });
    assert.equal(r.status, 400, `a mixed filter was accepted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /mixes both grammars/);
  });

  it('applies the key allowlist INSIDE $or, so the widening cannot smuggle a field', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      filter: { $or: [{ embedding: { $exists: true } }] },
    }) });
    assert.equal(r.status, 400, `a disallowed key inside $or was accepted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /embedding/);
  });

  it('filter eq rejected — rejected entity appears, accepted does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'rejected' } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(acceptedId), `Accepted entity must NOT be in rejected-filter results`);
    assert.ok(ids.includes(rejectedId), `Rejected entity (${rejectedId}) must be in results`);
  });

  it('filter ne rejected — accepted entity appears, rejected does not', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { ne: 'rejected' } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity must appear with ne:rejected filter`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity must NOT appear with ne:rejected filter`);
  });
});

describe('Recall filter — numeric gt/gte/lt/lte on properties', () => {
  const desc = `numeric-filter-test-count-${RUN}`;
  let highId;
  let lowId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const high = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} high-count`,
      description: desc,
      properties: { count: 50, label: 'high' },
      tags: ['numeric-test'],
    });
    assert.equal(high.status, 201, `Create high-count memory failed: ${JSON.stringify(high.body)}`);
    highId = high.body._id;

    const low = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} low-count`,
      description: desc,
      properties: { count: 5, label: 'low' },
      tags: ['numeric-test'],
    });
    assert.equal(low.status, 201, `Create low-count memory failed: ${JSON.stringify(low.body)}`);
    lowId = low.body._id;

    await waitForIndexed([highId, lowId], ['memory']);
  });

  it('filter gt:10 returns high-count record, excludes low-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { gt: 10 } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(highId), `High-count memory must appear with gt:10 filter`);
    assert.ok(!ids.includes(lowId), `Low-count memory must NOT appear with gt:10 filter`);
  });

  it('filter lte:10 returns low-count record, excludes high-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { lte: 10 } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(highId), `High-count memory must NOT appear with lte:10 filter`);
    assert.ok(ids.includes(lowId), `Low-count memory must appear with lte:10 filter`);
  });

  it('filter gte:5 and lt:100 (range) returns only high-count and low-count', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.count': { gte: 5, lt: 100 } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(highId), `High-count memory must appear with gte:5,lt:100 filter`);
    assert.ok(ids.includes(lowId), `Low-count memory must appear with gte:5,lt:100 filter`);
  });
});

describe('Recall filter — tags in (any-of)', () => {
  const desc = `tags-filter-test-${RUN}`;
  let securityId;
  let infraId;
  let unrelatedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const sec = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} security-tagged`,
      description: desc,
      tags: ['security', 'auth'],
    });
    assert.equal(sec.status, 201, `Create security memory failed: ${JSON.stringify(sec.body)}`);
    securityId = sec.body._id;

    const infra = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} infra-tagged`,
      description: desc,
      tags: ['infra'],
    });
    assert.equal(infra.status, 201, `Create infra memory failed: ${JSON.stringify(infra.body)}`);
    infraId = infra.body._id;

    const unrel = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} unrelated-tagged`,
      description: desc,
      tags: ['unrelated-tag-xyzzy'],
    });
    assert.equal(unrel.status, 201, `Create unrelated memory failed: ${JSON.stringify(unrel.body)}`);
    unrelatedId = unrel.body._id;

    await waitForIndexed([securityId, infraId, unrelatedId], ['memory']);
  });

  it('filter tags in ["security","infra"] returns both security and infra records, not unrelated', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'tags': { in: ['security', 'infra'] } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(securityId), `Security-tagged memory must appear`);
    assert.ok(ids.includes(infraId), `Infra-tagged memory must appear`);
    assert.ok(!ids.includes(unrelatedId), `Unrelated-tagged memory must NOT appear`);
  });
});

describe('Recall filter — exists operator', () => {
  const desc = `exists-filter-test-${RUN}`;
  let withPropId;
  let withoutPropId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const withProp = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} with-domain-prop`,
      description: desc,
      properties: { domain: 'infra' },
      tags: ['exists-test'],
    });
    assert.equal(withProp.status, 201, `Create with-prop memory failed: ${JSON.stringify(withProp.body)}`);
    withPropId = withProp.body._id;

    const withoutProp = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} without-domain-prop`,
      description: desc,
      tags: ['exists-test'],
    });
    assert.equal(withoutProp.status, 201, `Create without-prop memory failed: ${JSON.stringify(withoutProp.body)}`);
    withoutPropId = withoutProp.body._id;

    await waitForIndexed([withPropId, withoutPropId], ['memory']);
  });

  it('filter exists:true on properties.domain returns only records that have that property', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.domain': { exists: true } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(withPropId), `Record with property must appear`);
    assert.ok(!ids.includes(withoutPropId), `Record without property must NOT appear`);
  });

  it('filter exists:false on properties.domain returns only records without that property', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc,
      types: ['memory'],
      topK: 20,
      filter: { 'properties.domain': { exists: false } },
    }) });
    assert.equal(r.status, 200, `recall returned ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(!ids.includes(withPropId), `Record with property must NOT appear`);
    assert.ok(ids.includes(withoutPropId), `Record without property must appear`);
  });
});

// Space-parameterized variant (the schema test uses a second space). Thin wrapper over the shared poll so both
// spaces get the same measured deadline and the same diagnosis on failure.
const waitForIndexedIn = (spaceId, ids, types = ['entity', 'memory'], timeoutMs) =>
  waitForIndexedShared(INSTANCES.a, token(), spaceId, ids, types, timeoutMs);

// ── P6: tags param uses ALL-of semantics on the native filter fast path ────────
describe('Recall filter — tags param (must contain ALL; native fast path)', () => {
  const desc = `tags-all-test-${RUN}`;
  let bothId;
  let oneId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    // `tags` is a fixed declared filter field, so the `tags` recall param is pushed into the
    // $vectorSearch native filter as an $and of equalities — i.e. the record must carry EVERY tag.
    const both = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} has-both-tags`, description: desc, tags: ['alpha-all', 'beta-all'],
    });
    assert.equal(both.status, 201, `create both-tags: ${JSON.stringify(both.body)}`);
    bothId = both.body._id;

    const one = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/memories`, {
      fact: `${desc} has-one-tag`, description: desc, tags: ['alpha-all'],
    });
    assert.equal(one.status, 201, `create one-tag: ${JSON.stringify(one.body)}`);
    oneId = one.body._id;

    await waitForIndexed([bothId, oneId], ['memory']);
  });

  it('tags:[alpha,beta] returns only the record carrying BOTH tags', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: desc, types: ['memory'], topK: 20, tags: ['alpha-all', 'beta-all'],
    }) });
    assert.equal(r.status, 200, `recall ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(bothId), 'record with BOTH tags must appear');
    assert.ok(!ids.includes(oneId), 'record with only one of the tags must NOT appear (ALL semantics)');
  });
});

// ── P6/Q1: a schema-declared property becomes a native filter field ───────────
describe('Recall filter — schema-declared property (native path via typeSchemas)', () => {
  const SCHEMA_SPACE = `filter-schema-${RUN}`;
  const desc = `schema-prop-filter-region-${RUN}`;
  let northId;
  let southId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const cr = await post(INSTANCES.a, token(), '/api/spaces', { id: SCHEMA_SPACE, label: `Schema Filter ${RUN}` });
    assert.equal(cr.status, 201, `create schema space: ${JSON.stringify(cr.body)}`);
    await ensureReindexed(INSTANCES.a, token());

    // Declaring entity.site.propertySchemas.region makes `properties.region` a $vectorSearch filter
    // field (P6), so a recall filtering on it takes the native prefilter path. (Correctness holds
    // via the ENN fallback even before the index finishes rebuilding, so this test never flakes on
    // rebuild timing — it asserts the RESULT, which both paths must produce identically.)
    const patch = await fetch(`${INSTANCES.a}/api/spaces/${SCHEMA_SPACE}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { typeSchemas: { entity: { site: { propertySchemas: { region: { type: 'string' } } } } } } }),
    });
    assert.ok(patch.ok, `schema PATCH failed: ${patch.status}`);

    // Identical description → identical similarity; only the declared property distinguishes them.
    const north = await post(INSTANCES.a, token(), `/api/brain/spaces/${SCHEMA_SPACE}/entities`, {
      name: `site-north-${RUN}`, type: 'site', description: desc, properties: { region: 'north' },
    });
    assert.equal(north.status, 201, `create north: ${JSON.stringify(north.body)}`);
    northId = north.body._id;

    const south = await post(INSTANCES.a, token(), `/api/brain/spaces/${SCHEMA_SPACE}/entities`, {
      name: `site-south-${RUN}`, type: 'site', description: desc, properties: { region: 'south' },
    });
    assert.equal(south.status, 201, `create south: ${JSON.stringify(south.body)}`);
    southId = south.body._id;

    await waitForIndexedIn(SCHEMA_SPACE, [northId, southId], ['entity']);
  });

  after(async () => {
    await fetch(`${INSTANCES.a}/api/spaces/${SCHEMA_SPACE}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  it('filter properties.region eq north returns only the north site', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SCHEMA_SPACE, ...({
      query: desc, types: ['entity'], topK: 20, filter: { 'properties.region': { eq: 'north' } },
    }) });
    assert.equal(r.status, 200, `recall ${r.status}: ${JSON.stringify(r.body)}`);
    const ids = r.body.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(northId), 'north site must appear');
    assert.ok(!ids.includes(southId), 'south site must NOT appear');
  });
});

describe('Recall filter — MCP recall tool accepts filter', () => {
  let session;
  const sharedDesc = `mcp-filter-test-auth-decision-${RUN}`;
  let acceptedId;
  let rejectedId;

  before(async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    session = await openMcpSession(token());

    const acc = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `MCP-ADR-accepted-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'accepted' },
      tags: ['mcp-filter-test'],
    });
    assert.equal(acc.status, 201, `Create accepted entity failed: ${JSON.stringify(acc.body)}`);
    acceptedId = acc.body._id;

    const rej = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `MCP-ADR-rejected-${RUN}`,
      type: 'decision',
      description: sharedDesc,
      properties: { status: 'rejected' },
      tags: ['mcp-filter-test'],
    });
    assert.equal(rej.status, 201, `Create rejected entity failed: ${JSON.stringify(rej.body)}`);
    rejectedId = rej.body._id;

    await waitForIndexed([acceptedId, rejectedId], ['entity']);
  });

  after(() => session?.close());

  it('MCP recall with filter returns only matching records', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const result = await session.callTool('recall', {
      space: SPACE,
      query: sharedDesc,
      types: ['entity'],
      topK: 20,
      filter: { 'properties.status': { eq: 'accepted' } },
    });
    assert.ok(!result?.isError, `recall with filter returned isError: ${JSON.stringify(result)}`);
    const text = result?.content?.[0]?.text ?? '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      assert.fail(`MCP recall response must be valid JSON, got: ${text}`);
    }
    assert.ok(Array.isArray(parsed.results), '"results" must be an array');
    const ids = parsed.results.map(x => x.record?._id ?? x._id);
    assert.ok(ids.includes(acceptedId), `Accepted entity must appear via MCP filter`);
    assert.ok(!ids.includes(rejectedId), `Rejected entity must NOT appear via MCP filter`);
  });

  it('MCP recall with invalid filter key returns isError', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const result = await session.callTool('recall', {
      space: SPACE,
      query: 'test',
      filter: { 'injected.field': { eq: 'value' } },
    });
    assert.ok(result?.isError, `Invalid filter key must return isError=true`);
  });
});
