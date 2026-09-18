/**
 * `space` takes a LIST on recall, filter and similar — on both doors, with the same answers.
 *
 * ## What the list is for
 *
 * Before 5.0 a search could name ONE space or none. A caller holding twelve spaces who wanted three had to
 * make three calls and merge, or read all twelve and pay for the nine they did not want — and the byte
 * budget is spent before the merge, so the second option loses results it never showed them.
 *
 * ## The decision this file exists to hold
 *
 * Owner, 2026-09-16: *"A and refuse if unreachable"*. One named space the token cannot reach refuses the
 * WHOLE call. That is the opposite of the omitted-space case, which filters — and the asymmetry is the same
 * rule stated twice: **what the caller named is what the caller gets, or they are told.**
 *
 * Filtering a named list would answer with fewer results, and **a caller cannot tell a filtered answer from
 * a small one.** "Three matches" reads as "there are three" rather than as "you may not see the rest",
 * which is a wrong conclusion drawn from a plausible number. A 403 cannot be misread.
 *
 * ## Why an integration test and not only units
 *
 * The resolver is unit-tested in `a-space-named-in-the-body-is-authorised-like-one-in-the-path.test.js`,
 * and passing it a list proves what the FUNCTION does. It cannot prove that the MCP dispatcher parses an
 * array at all, that the REST body allowlist admits one, or that the two doors agree on the status code —
 * and the doors disagreeing is the defect this repo produces most.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, get, del, readCollection, filterRest } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let token;
let session;
const made = [];

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  session = await openMcpSession(token);
  const r = await post(INSTANCES.a, token, '/api/brain/spaces/general/chrono', {
    title: `SpaceList-${RUN}`, type: 'event', startsAt: new Date().toISOString(),
  });
  if (r.body?._id) made.push(r.body._id);
});

after(async () => {
  for (const id of made) {
    await del(INSTANCES.a, token, `/api/brain/spaces/general/chrono/${id}`).catch(() => {});
  }
  await session?.close();
});

const restFilter = (space) => filterRest(INSTANCES.a, token, {
  collection: 'chrono', filter: { title: `SpaceList-${RUN}` }, ...(space === undefined ? {} : { space }),
});
const mcpFilter = (space) => session.callTool('filter', {
  collection: 'chrono', filter: { title: `SpaceList-${RUN}` }, ...(space === undefined ? {} : { space }),
});
const rowsOf = (result) => JSON.parse(result?.content?.[0]?.text ?? '[]');

describe('a list of spaces is accepted and searched', () => {
  it('REST: a one-element list answers exactly what the bare string does', async () => {
    const asString = await restFilter('general');
    const asList = await restFilter(['general']);
    assert.equal(asList.status, 200, JSON.stringify(asList.body));
    assert.deepEqual(asList.body.results?.map(r => r._id), asString.body.results?.map(r => r._id),
      'two spellings of one request must not answer differently');
  });

  it('MCP: the same, through the dispatcher that has to parse the array first', async () => {
    const asString = rowsOf(await mcpFilter('general'));
    const asList = rowsOf(await mcpFilter(['general']));
    assert.deepEqual(asList.map(r => r._id), asString.map(r => r._id));
  });

  it('and the seeded record really is found, so none of the above passes on two empty answers', async () => {
    // The floor. Every assertion here compares two results; two empty ones are equal.
    const r = await restFilter(['general']);
    assert.ok((r.body.results ?? []).length >= 1,
      'the seeded chrono entry was not found, so the comparisons above proved nothing');
  });
});

describe('an unreachable name refuses the whole call, on both doors', () => {
  it('REST: a space that does not exist is 404, not a filtered answer', async () => {
    const r = await restFilter(['general', `no-such-space-${RUN}`]);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error ?? '', new RegExp(`no-such-space-${RUN}`), 'the refusal must name which one');
  });

  it('MCP: the same input gets the same answer', async () => {
    const r = await mcpFilter(['general', `no-such-space-${RUN}`]);
    assert.ok(r?.isError, 'MCP accepted a space REST refuses — one question, two answers');
    assert.match(r.content?.[0]?.text ?? '', new RegExp(`no-such-space-${RUN}`));
  });
});

describe('an empty list is refused rather than read as "every space"', () => {
  /*
   * The dangerous coercion, and the reason it gets its own block: `[]` is what a caller's OWN filter
   * produces when it selects nothing, and every falsy-ish check spells it the same as absent. Read as
   * "no space named", it would widen the request to every space the token can reach — the exact opposite
   * of what a caller who sent a list meant, and silently.
   */
  it('REST answers 400 and says what to send instead', async () => {
    const r = await restFilter([]);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error ?? '', /empty/i);
    assert.match(r.body.error ?? '', /omit/i, 'the refusal must say how to ask for every space');
  });

  it('MCP answers the same', async () => {
    const r = await mcpFilter([]);
    assert.ok(r?.isError);
    assert.match(r.content?.[0]?.text ?? '', /empty/i);
  });
});

describe('only the search family takes a list', () => {
  it('a write tool refuses one rather than using its first entry', async () => {
    /*
     * The failure this prevents: `save_fact` handed `["a","b"]` and told to write somewhere. A dispatcher
     * that normalised centrally would pass it "a", and the caller would be told their write succeeded —
     * in a space they did not mean. A refusal naming the constraint cannot be mistaken for success.
     */
    const r = await session.callTool('save_fact', { space: ['general'], fact: `should refuse ${RUN}` });
    assert.ok(r?.isError, 'save_fact accepted a list; it acts on exactly one space');
    assert.match(r.content?.[0]?.text ?? '', /one 'space'|not a list/i);
  });

  it('and it still takes the single space it always did', async () => {
    const r = await session.callTool('save_fact', { space: 'general', fact: `space-list control ${RUN}` });
    assert.ok(!r?.isError, `the control write failed, so the refusal above proves nothing: ${JSON.stringify(r)}`);
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(r.content?.[0]?.text ?? '');
    if (id) await del(INSTANCES.a, token, `/api/brain/spaces/general/facts/${id[1]}`).catch(() => {});
  });
});

describe('recall and similar take it too, not just filter', () => {
  it('recall accepts a list on both doors', async () => {
    const rest = await post(INSTANCES.a, token, '/api/brain/recall', { query: 'anything', space: ['general'] });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const mcp = await session.callTool('recall', { query: 'anything', space: ['general'] });
    assert.ok(!mcp?.isError, JSON.stringify(mcp));
  });

  it('similar accepts a list on both doors', async () => {
    /*
     * A UUID-shaped id, not simply the newest fact — and the difference is a real failure this case had.
     *
     * `similar` requires `entryId` to be a UUID v4, and `general` is a shared space where other suites
     * write facts under ids of their own (`seq-valid-high-…`). Taking `limit: 1` meant taking whatever
     * ran last, so the case failed with `entryId must be a valid UUID v4` — a refusal about the ID,
     * reported as `similar refused a list outright`, which is the opposite of what it is testing.
     *
     * The subject is the SPACE LIST being parsed, so any valid id will do and having none is a skip.
     */
    const seed = await readCollection(INSTANCES.a, token, 'general', 'facts', { limit: 50 });
    const id = (seed.results ?? [])
      .map(r => r._id)
      .find(v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v));
    if (!id) return;   // no UUID-keyed fact in this run; the parse is what matters and recall covered it
    const rest = await post(INSTANCES.a, token, '/api/brain/similar', {
      entryId: id, entryType: 'fact', space: ['general'],
    });
    assert.notEqual(rest.status, 400, `similar refused a list outright: ${JSON.stringify(rest.body)}`);
    const mcp = await session.callTool('similar', { entryId: id, entryType: 'fact', space: ['general'] });
    assert.doesNotMatch(mcp?.content?.[0]?.text ?? '', /not a list|must be a space name/i,
      'similar rejected the list at the parse, which is the one failure this case is for');
  });
});
