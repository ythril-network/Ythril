/**
 * The SAME recall filter is accepted, or refused, identically on both doors.
 *
 * ## Why this test and not another capability check
 *
 * `mcp-rest-parity.test.js` gates the capability half — does the tool exist for the route. `CLAUDE.md` says
 * the other half is the one that hides:
 *
 * > **Parameters count too, and this is the half that hides.** A capability present on both surfaces still
 * > violates the rule if one door accepts less.
 *
 * And it names this exact defect as the example. It was real. Measured on one instance, one space, the same
 * instant, with the canary operator's own filter from 2026-08-17 §10:
 *
 *     filter { type: 'message', 'properties.readBy': { $not: { $regex: 'ythril' } } }
 *
 *     REST  POST /recall  ->  200, returns the record
 *     MCP   recall        ->  isError: /filter/type: must be object;
 *                                      /filter/properties.readBy: unexpected property '$not'
 *
 * Two refusals in one filter, both the MCP `inputSchema` being narrower than the server: a bare
 * `type: 'message'` is valid raw-Mongo equality, and `$not` is on the allowlist `query` takes. Meanwhile the
 * tool's own description promised raw MongoDB. **The 3.0.0 notice promised it too**, so a caller who read
 * either was told they had something the schema refused.
 *
 * A source-reading gate could not have caught this: the description was right, the resolver was right, and the
 * two disagreed only when a real filter met the dispatcher. So the test drives both doors.
 *
 * Run: node --test testing/integration/recall-filter-parity-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `filter-parity-${RUN}`;

let token;
let seeded = false;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `Filter parity ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
    name: `parity-note-${RUN}`,
    type: 'message',
    description: 'A board note about retrieval, for the parity filter to match.',
    properties: { readBy: 'the canary operator', status: 'open' },
    tags: ['parity'],
    waitForEmbedding: true,
  });
  seeded = r.status === 201;
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

/** REST: did this filter produce an answer, or a refusal? */
async function viaRest(filter) {
  const r = await post(INSTANCES.a, token, '/api/brain/recall', { space: SPACE, ...({ query: 'board note about retrieval', filter, includeFreshWrites: true, topK: 10 }) });
  return { accepted: r.status === 200, detail: r.status === 200 ? '' : JSON.stringify(r.body).slice(0, 200) };
}

/** MCP: the same question through the other door. `isError` is this transport's refusal. */
async function viaMcp(filter) {
  const session = await openMcpSession(token);
  try {
    const res = await session.callTool('recall', {
      space: SPACE, query: 'board note about retrieval', filter, includeFreshWrites: true, topK: 10,
    });
    const text = res?.content?.[0]?.text ?? '';
    return { accepted: !res?.isError, detail: res?.isError ? text.slice(0, 200) : '' };
  } finally {
    session.close();
  }
}

/**
 * Every filter here is sent to BOTH doors and the two verdicts compared.
 *
 * `expected` is asserted as well as the agreement, because two doors that agree on the WRONG answer would
 * satisfy an agreement-only test — and the raw-Mongo cases were refused on both doors before the grammar was
 * widened, so agreement alone would have passed then too.
 */
const CASES = [
  {
    what: "the canary operator's own filter — the reported case, verbatim",
    filter: { type: 'message', 'properties.readBy': { $not: { $regex: 'ythril' } } },
    expected: true,
  },
  { what: 'raw $or across allowlisted keys',
    filter: { $or: [{ type: 'message' }, { 'properties.status': 'open' }] }, expected: true },
  { what: 'raw $and with a nested $in',
    filter: { $and: [{ type: { $in: ['message', 'note'] } }, { 'properties.status': 'open' }] }, expected: true },
  { what: 'raw equality on a bare string value',
    filter: { type: 'message' }, expected: true },
  { what: 'the LEGACY grammar, which must keep working',
    filter: { 'properties.status': { eq: 'open' } }, expected: true },
  { what: 'legacy grammar with two keys, ANDed',
    filter: { type: { eq: 'message' }, 'properties.status': { eq: 'open' } }, expected: true },

  // ── Refusals. Both doors must refuse these, and for the same reason. ────────────────────────────────────
  { what: 'a key outside the allowlist — the injection guard, which widening must NOT have loosened',
    filter: { $or: [{ spaceId: 'other-space' }] }, expected: false },
  { what: 'a key outside the allowlist at the top level',
    filter: { _id: 'anything' }, expected: false },
  { what: 'a MIXED filter — raw and legacy together, which is a caller believing two things',
    filter: { $or: [{ type: 'message' }], 'properties.status': { eq: 'open' } }, expected: false },
];

describe('recall filter: both doors accept and refuse the same things', () => {
  for (const { what, filter, expected } of CASES) {
    it(`${expected ? 'accepts' : 'refuses'}: ${what}`, async (t) => {
      if (!seeded) return t.skip('seed write unavailable');
      const [rest, mcp] = await Promise.all([viaRest(filter), viaMcp(filter)]);

      assert.equal(rest.accepted, expected,
        `REST should ${expected ? 'accept' : 'refuse'} ${JSON.stringify(filter)} — got ${rest.detail}`);
      assert.equal(mcp.accepted, expected,
        `MCP should ${expected ? 'accept' : 'refuse'} ${JSON.stringify(filter)} — got ${mcp.detail}`);
      // The agreement, stated separately so a failure says which half moved rather than only that one did.
      assert.equal(rest.accepted, mcp.accepted,
        `the two doors disagree about ${JSON.stringify(filter)}: REST ${rest.accepted ? 'accepted' : 'refused'}, `
        + `MCP ${mcp.accepted ? 'accepted' : 'refused'} — this is the parity defect CLAUDE.md calls the half `
        + `that hides. REST said "${rest.detail}", MCP said "${mcp.detail}"`);
    });
  }

  it('and the raw filter actually MATCHES, so acceptance is not an empty answer', async (t) => {
    if (!seeded) return t.skip('seed write unavailable');
    // A filter that is accepted and matches nothing would satisfy every assertion above while proving the
    // grammar reaches no records. `$not` on a value that is present is the reported shape, and the seeded
    // record's `readBy` is "the canary operator" — so `$not /ythril/` must return it.
    const r = await post(INSTANCES.a, token, '/api/brain/recall', { space: SPACE, ...({
      query: 'board note about retrieval', includeFreshWrites: true, topK: 10,
      filter: { type: 'message', 'properties.readBy': { $not: { $regex: 'ythril' } } },
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.results.length >= 1,
      'the raw filter must reach the seeded record — an accepted filter returning nothing proves nothing');
    // By NAME, not by `type`. On a REST recall result `type` is the KNOWLEDGE type — `entity` — and the
    // entity's own `type` field (`message`, the thing the filter matched on) is shadowed by it in the flat
    // envelope. Asserting `type === 'message'` here failed while the filter was working perfectly, which is
    // the assertion being wrong rather than the product.
    assert.equal(r.body.results[0].name, `parity-note-${RUN}`,
      'and it must be the record the filter selected, not merely some record');
  });
});
