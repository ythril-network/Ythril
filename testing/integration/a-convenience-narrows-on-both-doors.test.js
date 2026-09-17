/**
 * `tag` and `search` narrow a list identically through `filter`'s two doors — against a live instance.
 *
 * ## What this proves that the source gate cannot
 *
 * `a-convenience-filter-reaches-both-doors.test.js` asserts the module is reached, that the schema
 * declares the five names, and that nothing assembles them a second time. All of that can be true of a
 * predicate that Mongo then ignores.
 *
 * What only a real query answers is whether the merged predicate NARROWS. That is the half that was
 * broken to begin with — `filter` accepted a Mongo predicate and knew nothing about `tag`, so an agent
 * could not ask for "facts tagged release" while a browser could.
 *
 * ## Why the two doors are compared record for record
 *
 * A convenience that works on one door and not the other is the exact defect this whole row is about,
 * and it is invisible from either side alone: each answers, plausibly, and the difference only shows
 * when somebody asks both. The `_id` sets are compared rather than the counts — a count can match while
 * the rows differ, which is the failure a count cannot tell from success.
 *
 * Run: node --test testing/integration/a-convenience-narrows-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `conveniences-${RUN}`;
const ENTITY_NAME = `Ada-${RUN}`;
const OTHER_NAME = `Grace-${RUN}`;

let token;
let mcp;
/** The one fact carrying the tag and the searched word; everything else must be excluded. */
let taggedId;

/*
 * `/api/brain/filter`, not `/api/filter`. Both are real doors and both were changed here — the generic
 * `/api/<tool-name>` route dispatches through `callTool`, so the MCP half below already covers it, and
 * it wraps its answer in `{ok, text, data}`. This one returns the envelope directly, which is what makes
 * the record-for-record comparison below readable.
 */
const viaRest = async (args) => {
  const res = await fetch(`${INSTANCES.a}/api/brain/filter`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

const viaMcp = async (args) => {
  const r = await mcp.callTool('filter', args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

const idsOf = (rows) => (rows ?? []).map(r => r._id).sort();

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `Conveniences ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const tagged = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
    fact: `The rollout was approved ${RUN}`, tags: ['release-candidate'], description: 'signed off by ops',
  });
  assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
  taggedId = tagged.body._id;

  const e1 = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: ENTITY_NAME, type: 'concept' });
  const e2 = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: OTHER_NAME, type: 'concept' });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(e2.status, 201, JSON.stringify(e2.body));
  const edge = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges`, {
    from: e1.body._id, to: e2.body._id, label: 'relates_to',
  });
  assert.equal(edge.status, 201, JSON.stringify(edge.body));

  // Two decoys: one sharing neither the tag nor the word, one sharing the TAG PREFIX but not the tag,
  // so an exact-match implementation and a substring one give different answers.
  for (const [fact, tags] of [
    [`An unrelated note ${RUN}`, ['housekeeping']],
    [`Another note ${RUN}`, ['release']],
  ]) {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, { fact, tags });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});

after(async () => {
  try { await mcp?.close?.(); } catch { /* the session may already be gone */ }
  // Always torn down: the four-node stack is shared, and a left-behind space fails somebody else's suite.
  try { await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: SPACE }); } catch { /* best effort */ }
});

describe('a convenience narrows, and narrows the same way on both doors', () => {
  it('`tag` is a SUBSTRING, so it finds the record and not only an exact tag', async () => {
    const rest = await viaRest({ space: SPACE, collection: 'facts', tag: 'release-cand' });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(idsOf(rest.body.results), [taggedId],
      `\`tag\` did not narrow to the tagged record: ${JSON.stringify(rest.body.results?.map(r => r.tags))}`);
  });

  it('and the tool answers with the same rows, not merely the same count', async () => {
    const rest = await viaRest({ space: SPACE, collection: 'facts', tag: 'release' });
    const mcpAnswer = await viaMcp({ space: SPACE, collection: 'facts', tag: 'release' });
    assert.ok(!mcpAnswer.isError, `the tool refused a convenience the route served: ${mcpAnswer.text}`);
    assert.deepEqual(idsOf(mcpAnswer.body.results), idsOf(rest.body.results),
      'the two doors returned different records for the same `tag`');
    // Both decoys share nothing but the space, so a working substring match returns exactly two.
    assert.equal(rest.body.results.length, 2, JSON.stringify(rest.body.results.map(r => r.tags)));
  });

  it('`search` spans the collection\'s text fields on both doors', async () => {
    const args = { space: SPACE, collection: 'facts', search: 'rollout' };
    const rest = await viaRest(args);
    const mcpAnswer = await viaMcp(args);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(idsOf(rest.body.results), [taggedId], 'search did not narrow on the REST door');
    assert.deepEqual(idsOf(mcpAnswer.body.results), [taggedId], 'search did not narrow on the tool door');
  });

  it('a convenience beside a caller `$or` keeps BOTH — the guard the module exists for', async () => {
    /*
     * The silent failure this change could have introduced. `search` produces an `$or`; assigning it onto
     * a caller predicate that already has one REPLACES theirs, and the answer is a plausible superset
     * with nothing logged. Asserted live because the merge is only observable in what Mongo returns.
     *
     * The caller's `$or` admits both decoys and excludes the tagged record; `search` admits only the
     * tagged record. Together they must match NOTHING. An assignment in either direction returns rows.
     */
    const args = {
      space: SPACE, collection: 'facts', search: 'rollout',
      filter: { $or: [{ tags: 'housekeeping' }, { tags: 'release' }] },
    };
    const rest = await viaRest(args);
    const mcpAnswer = await viaMcp(args);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(rest.body.results, [],
      `the caller's $or was dropped: ${JSON.stringify(rest.body.results?.map(r => r.tags))}`);
    assert.deepEqual(mcpAnswer.body.results, [],
      `the caller's $or was dropped on the tool door: ${JSON.stringify(mcpAnswer.body.results)}`);
  });

  it('`filter` may be omitted entirely when a convenience is the whole question', async () => {
    // It was REQUIRED until 5.0, so narrowing by tag alone meant sending `filter: {}` — a shape a caller
    // has to be told about. Both doors dropped the requirement in the same change.
    const rest = await viaRest({ space: SPACE, collection: 'facts', tag: 'release-cand' });
    const mcpAnswer = await viaMcp({ space: SPACE, collection: 'facts', tag: 'release-cand' });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.ok(!mcpAnswer.isError, `the tool still requires \`filter\`: ${mcpAnswer.text}`);
    assert.deepEqual(idsOf(mcpAnswer.body.results), [taggedId]);
  });

  it('`links` REFUSES a convenience rather than returning every link', async () => {
    /*
     * The other honest answer. A link is a pair of ids — no tags, no text — so `search` there would match
     * everything, and a filter that matched everything reads exactly like a filter that was ignored.
     * Both doors refuse, and the refusal names the collection.
     */
    const args = { space: SPACE, collection: 'links', search: 'anything' };
    const rest = await viaRest(args);
    const mcpAnswer = await viaMcp(args);
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.match(rest.body.error, /links/, 'the refusal must name the collection');
    assert.ok(mcpAnswer.isError, `the tool served a convenience the route refused: ${mcpAnswer.text}`);
    assert.match(mcpAnswer.text, /links/, 'and the tool refusal must name it too');
  });
});

describe('the decorations arrive on both doors, against a real instance', () => {
  it('an edge from `filter` carries both endpoint NAMES, not two UUIDs', async () => {
    /*
     * The list route has resolved these all along and `filter` did not, so an agent got ids and a
     * browser got names. Proved live because the resolution is a per-member join — a source gate can
     * see the call and not whether it found anything.
     */
    const args = { space: SPACE, collection: 'edges' };
    const rest = await viaRest(args);
    const mcpAnswer = await viaMcp(args);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const [row] = rest.body.results ?? [];
    assert.ok(row, `no edge came back: ${JSON.stringify(rest.body)}`);
    assert.equal(row.fromName, ENTITY_NAME, `fromName not resolved: ${JSON.stringify(row)}`);
    assert.equal(row.toName, OTHER_NAME, `toName not resolved: ${JSON.stringify(row)}`);
    // And identically through the tool — the point of the module is that it cannot be one door only.
    const [mrow] = mcpAnswer.body.results ?? [];
    assert.equal(mrow?.fromName, row.fromName, 'the tool door returned a different fromName');
    assert.equal(mrow?.toName, row.toName, 'the tool door returned a different toName');
  });

  it('and the same edge through the LIST route agrees, so the two shapes are one answer', async () => {
    // The route is what `B-9` step 3 deletes. If the names it produces and the ones `filter` produces
    // ever differ, deleting it is a behaviour change nobody planned.
    const res = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/edges`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const [viaList] = body.edges ?? [];
    const [viaFilter] = (await viaRest({ space: SPACE, collection: 'edges' })).body.results ?? [];
    assert.equal(viaList?.fromName, viaFilter?.fromName, 'the route and the tool disagree about fromName');
    assert.equal(viaList?.toName, viaFilter?.toName, 'the route and the tool disagree about toName');
  });

  it('`includeDiagnostics` adds the withheld fields back on both doors, and is off by default', async () => {
    /*
     * The flag was honoured by the list routes and accepted by NEITHER door of `filter` — a 400 on the
     * route and an `additionalProperties` refusal on the tool. Admitting it without wiring the
     * projection would have been the worse half: a 200 with the flag doing nothing.
     */
    const off = await viaRest({ space: SPACE, collection: 'facts' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.ok(off.body.results.every(r => !('embeddingModel' in r)),
      `a diagnostics field came back with the flag OFF: ${JSON.stringify(off.body.results[0])}`);

    const on = await viaRest({ space: SPACE, collection: 'facts', includeDiagnostics: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const mcpOn = await viaMcp({ space: SPACE, collection: 'facts', includeDiagnostics: true });
    assert.ok(!mcpOn.isError, `the tool refused a flag the route accepts: ${mcpOn.text}`);
    // Asserted as agreement rather than presence: whether a record HAS `embeddingModel` depends on the
    // embedder having run, and a case that needs it to have run is a case that fails on a slow stack.
    const hasOnRest = on.body.results.some(r => 'embeddingModel' in r);
    const hasOnMcp = (mcpOn.body.results ?? []).some(r => 'embeddingModel' in r);
    assert.equal(hasOnMcp, hasOnRest, 'one door restored the diagnostics and the other did not');
  });
});
