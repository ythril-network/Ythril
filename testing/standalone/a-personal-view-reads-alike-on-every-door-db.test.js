/**
 * A personal view reads alike on every door, is invisible to every other token, and is refused by every write door (Q-531,
 * bundle-100, plan rev 3.2).
 *
 * ## The rules
 *
 * 1. **Parity.** An owner's `@name` read through the REST tool door (`POST /api/filter`), MCP `filter` and the REST path route
 *    (`GET /api/brain/spaces/@name/stats`) answers the same rows, and each answer's `viewMembers` lists exactly the members read
 *    (sandwiched: door A, door B, door A again). The body-scoped `/api/brain/recall` and `/api/brain/similar` resolve the view
 *    (this stack has no vector search: they are held to resolving it, and `similar` to locating a seed in a member). Every derived
 *    read door (ROUTE_RIGHTS path rows and TOOL_RIGHTS rows that need `read` outside the schema area) accepts the owner's view id.
 * 2. **Mixed rungs.** An owner whose knowledge rung on one member is gone reads the other member's marker and NOT that member's,
 *    and `viewMembers` names only the member read.
 * 3. **Another token's view** answers exactly as an unknown id for that door and token kind, and the status is PINNED per door and
 *    kind (an instance admin, a row-scoped token, a floor token): REST path 404 / 403 / 404, body-scoped and tool door 404, MCP an
 *    error "Space '<id>' not found". Equal-to-unknown alone would let a 500 equal a 500.
 * 4. **Write doors.** Every mounted non-GET route with a space parameter (`:spaceId`, or `:id` under `/api/spaces`) that is not a
 *    read, every MCP tool that takes `space` and is not a `TOOL_RIGHTS` read (classified from `TOOL_RIGHTS` and the tool's own flags,
 *    never from the enum; a tool that takes `space` with neither is UNCLASSIFIED and fails), and the tool door for each of those
 *    tools refuse the owner's view id with `Space '@w' not found` and the hint `'@w' is a view; write to one of its member spaces`
 *    (MCP the same text), before any storage effect in a member; another token gets the plain answer, no hint.
 * 5. **The five record DELETE routes** (entities, facts, edges, chrono, links) refuse a view id with the space refusal, and the
 *    member's record remains.
 * 6. **`targetSpace`** is refused BY NAME, with `space` as its replacement, on both doors and both REST spellings (query, body).
 * 7. **`proxyFor`** on `POST /api/spaces` and `save_space` is refused BY NAME with its replacement (`POST /api/views`, `view_create`).
 *
 * ## Seen red at 18e8d598, and why each red is the right one
 *
 * - 1-3: `POST /api/views` answers 404 `Not found` (no views API), so the owner's own read answers `Space '@team' not found`.
 * - 4: every write door answers the unknown-space text with NO hint (a view is unknown, not "a view").
 * - 5: the five DELETE routes answer 404 `<Record> not found` (the record message): they have no existence check and loop the
 *   members of an unknown id (none). That is the right red: with a view resolver in place and no existence check, the same loop
 *   would walk the view's members and delete the record (a pre-6.0 proxy did exactly that: 204 and the record gone, probe P4).
 * - 6: 201, the entity lands (the field is accepted). 7: 201 / "Created space ... as a proxy".
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-personal-view-reads-alike-on-every-door-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { mountedRoutes } from './_routes.mjs';
import { openViewDoors, viewOf, rowsOf, viewMembersOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vp-qa';
const OPS = 'vp-ops';
const HINT = (id) => `'${id}' is a view; write to one of its member spaces`;
const UNKNOWN = (id) => `Space '${id}' not found`;
/** What `similar` answers once it has LOCATED its seed on a stack without vector search (see a-peer-token-meets-a-held-space...). */
const SEED_LOCATED = /vectorSearch|Semantic recall is unavailable|unavailable|exists in space/i;

let d, owner, mixedOwner, admin, rowTok, floorTok, markers;
const fmt = (a) => `${a.status ?? ''} ${(a.text ?? '').slice(0, 220)}`;
const markerIds = (a) => rowsOf(a).map(r => r._id).filter(id => Object.values(markers).includes(id)).sort();

async function createView(key, name, members) {
  const a = await d.rest(key, 'POST', '/api/views', { name, members });
  return { ok: a.status === 201 && viewOf(a)?.id === `@${name}`, answer: a };
}
const mustCreate = async (key, name, members) => {
  const { ok, answer } = await createView(key, name, members);
  assert.ok(ok, `POST /api/views {name: '${name}'} answered ${fmt(answer)}`);
};

/** The three reads that return rows or counts, on the three doors. */
const reads = {
  toolDoor: (key, space) => d.rest(key, 'POST', '/api/filter', { space, collection: 'entities', filter: {} }),
  mcp: (key, space) => d.mcp(key, 'filter', { space, collection: 'entities', filter: {} }),
  path: (key, space) => d.rest(key, 'GET', `/api/brain/spaces/${encodeURIComponent(space)}/stats`),
};

describe('a personal view reads alike on every door and writes nowhere (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-parity', spaces: [QA, OPS] });
    admin = await d.mint('vp-admin', {}, { admin: true });
    owner = await d.mint('vp-owner', { [QA]: d.row({ knowledge: 'read', files: 'read' }), [OPS]: d.row({ knowledge: 'read', files: 'read' }) });
    mixedOwner = await d.mint('vp-mixed', { [QA]: d.row({ knowledge: 'read', files: 'read' }), [OPS]: d.row({ knowledge: 'read', files: 'read' }) });
    rowTok = await d.mint('vp-row', { [QA]: d.row({ knowledge: 'read' }) });
    floorTok = (await d.tokens.createToken({ name: 'vp-floor', rights: { instanceAdmin: false, createSpaces: false, floor: d.row({ knowledge: 'read' }), perSpace: {} } }));
    floorTok = { key: floorTok.plaintext, id: floorTok.record.id };
    markers = {};
    for (const s of [QA, OPS]) {
      const a = await d.rest(admin.key, 'POST', `/api/brain/spaces/${s}/entities`, { name: `vp-marker-${s}`, type: 'thing' });
      assert.equal(a.status, 201, `seeding ${s}: ${fmt(a)}`);
      markers[s] = a.body._id;
    }
  });
  after(async () => { await d?.close(); });

  it('an own view reads the same rows on the tool door, MCP and the REST path route, and viewMembers names exactly the members read', async () => {
    await mustCreate(owner.key, 'team', [QA, OPS]);
    const a1 = await reads.toolDoor(owner.key, '@team');
    const m = await reads.mcp(owner.key, '@team');
    const a2 = await reads.toolDoor(owner.key, '@team');
    const p = await reads.path(owner.key, '@team');
    assert.deepEqual(markerIds(a1), markerIds(a2), 'the tool door answered differently on the two sides of the sandwich: the compared value moved');
    assert.deepEqual(markerIds(a1), [markers[QA], markers[OPS]].sort(), `tool door rows: ${fmt(a1)}`);
    assert.deepEqual(markerIds(m), markerIds(a1), `MCP rows differ from the tool door's: ${fmt(m)}`);
    assert.deepEqual([viewMembersOf(a1), viewMembersOf(m), viewMembersOf(p)], [[QA, OPS], [QA, OPS], [QA, OPS]], 'viewMembers on tool door, MCP, path');
    assert.equal(p.status, 200, `REST path stats: ${fmt(p)}`);
    assert.equal(p.body?.entities, rowsOf(a1).length, 'the path route counts other rows than the tool door reads');
  });

  it('the body-scoped recall and similar resolve the own view; similar locates a seed in a member', async () => {
    const recall = await d.rest(owner.key, 'POST', '/api/brain/recall', { query: 'vp marker', space: '@team' });
    const similar = await d.rest(owner.key, 'POST', '/api/brain/similar', { entryId: markers[QA], entryType: 'entity', space: '@team' });
    const unknown = (a) => a.status === 403 || a.error.includes(UNKNOWN('@team'));
    assert.ok(!unknown(recall), `recall on an own view answered as an unknown space: ${fmt(recall)}`);
    assert.ok(!unknown(similar) && SEED_LOCATED.test(similar.text), `similar on an own view did not locate the member's seed: ${fmt(similar)}`);
  });

  it('every derived read door accepts the owner\'s view id (REST path read rows, MCP read tools)', async () => {
    const { ROUTE_RIGHTS, TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    // The SSE stream is held open by design; its ticket door (POST .../events/ticket) is asked instead.
    const paths = ROUTE_RIGHTS.filter(r => r.needs === 'read' && r.area !== 'schema' && r.scope === 'path' && r.route.includes(':spaceId') && !r.route.endsWith('/events'));
    const tools = TOOL_RIGHTS.filter(r => r.needs === 'read' && r.area !== 'schema' && r.tool !== 'read_spill');
    assert.ok(paths.length >= 8 && tools.length >= 9, `derived ${paths.length} path read route(s) and ${tools.length} read tool(s); the derivation is broken`);
    const refused = [];
    for (const r of paths) {
      const url = r.route.replace(':spaceId', encodeURIComponent('@team')).replace(/:\w+/g, 'x');
      const a = await d.rest(owner.key, r.method, url, r.method === 'GET' ? undefined : {});
      if (a.status === 403 || a.error.includes(UNKNOWN('@team'))) refused.push(`${r.method} ${r.route}: ${fmt(a)}`);
    }
    for (const t of tools) {
      const a = await d.mcp(owner.key, t.tool, { space: '@team' });
      if (a.text.includes(UNKNOWN('@team')) || /allowed values|must be equal to one of/i.test(a.text)) refused.push(`MCP ${t.tool}: ${a.text.slice(0, 160)}`);
    }
    assert.deepEqual(refused, [], 'read doors that answer an own view as an unknown space');
  });

  it('a mixed-rung owner reads the readable member\'s marker and not the other\'s; viewMembers names only the one read', async () => {
    await mustCreate(mixedOwner.key, 'mix', [QA, OPS]);
    d.setRights(mixedOwner.id, r => { r.perSpace[OPS].knowledge = 'none'; });
    const a = await reads.toolDoor(mixedOwner.key, '@mix');
    const m = await reads.mcp(mixedOwner.key, '@mix');
    const p = await reads.path(mixedOwner.key, '@mix');
    for (const [door, ans] of [['tool door', a], ['MCP', m]]) {
      assert.deepEqual(markerIds(ans), [markers[QA]], `${door}: the readable member's marker present and the unreadable one's absent (${fmt(ans)})`);
    }
    assert.deepEqual([viewMembersOf(a), viewMembersOf(m), viewMembersOf(p)], [[QA], [QA], [QA]], 'viewMembers on tool door, MCP, path');
  });

  it('another token\'s view answers exactly as an unknown id, per door and token kind, at the pinned status', async () => {
    const created = await createView(owner.key, 'private', [QA]);
    const before_ = await reads.toolDoor(owner.key, '@private');
    const kinds = { admin, rowScoped: rowTok, floor: floorTok };
    const PIN = { path: { admin: 404, rowScoped: 403, floor: 404 }, recall: 404, similar: 404, toolDoor: 404 };
    const doors = {
      path: (k, id) => reads.path(k, id),
      recall: (k, id) => d.rest(k, 'POST', '/api/brain/recall', { query: 'x', space: id }),
      similar: (k, id) => d.rest(k, 'POST', '/api/brain/similar', { entryId: markers[QA], entryType: 'entity', space: id }),
      toolDoor: (k, id) => reads.toolDoor(k, id),
      mcp: (k, id) => reads.mcp(k, id),
    };
    const wrong = [];
    for (const [kind, t] of Object.entries(kinds)) {
      for (const [door, ask] of Object.entries(doors)) {
        const theirs = await ask(t.key, '@private');
        const unknown = await ask(t.key, '@nobody');
        const shape = (a, id) => ({ status: door === 'mcp' ? a.isError : a.status, text: (a.error || a.text).split(id).join('<id>') });
        try { assert.deepEqual(shape(theirs, '@private'), shape(unknown, '@nobody')); }
        catch { wrong.push(`${kind} ${door}: another's view ${JSON.stringify(shape(theirs, '@private'))} vs unknown ${JSON.stringify(shape(unknown, '@nobody'))}`); }
        const pinned = door === 'mcp' ? true : (typeof PIN[door] === 'object' ? PIN[door][kind] : PIN[door]);
        const got = door === 'mcp' ? theirs.isError && theirs.text.includes(UNKNOWN('@private')) : theirs.status;
        if (got !== pinned) wrong.push(`${kind} ${door}: answered ${fmt(theirs)}, pinned ${pinned}`);
        if (markerIds(theirs).length) wrong.push(`${kind} ${door}: rows of another token's view were served`);
      }
    }
    const after_ = await reads.toolDoor(owner.key, '@private');
    // The comparison and the pins are asserted first: they hold today as well, which is what makes the precondition below the red.
    assert.deepEqual(wrong, []);
    assert.ok(created.ok, `POST /api/views {name: 'private'} answered ${fmt(created.answer)}`);
    assert.deepEqual([markerIds(before_), markerIds(after_)], [[markers[QA]], [markers[QA]]],
      `the owner reads its own view on both sides of the comparison, so "another token sees an unknown id" is about a view that exists (${fmt(before_)})`);
  });

  it('every write door refuses the owner\'s view id with the hint before any storage effect; another token gets no hint', async () => {
    const { TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const created = await createView(admin.key, 'w', [QA, OPS]); // the REST and MCP sweep below runs either way: a missing view still says what each door does
    const ROUTE_READS = new Set((await import('../../server/dist/auth/space-rights.js')).ROUTE_RIGHTS.filter(r => r.needs === 'read').map(r => `${r.method} ${r.route}`));
    const routes = mountedRoutes().filter(r => r.method !== 'GET' && (/:spaceId\b/.test(r.path) || /^\/api\/spaces\/:id\b/.test(r.path)) && !ROUTE_READS.has(`${r.method} ${r.path}`));
    const SHAPE = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
    const takesSpace = (t) => { try { return 'space' in (t.inputSchema(SHAPE)?.properties ?? {}); } catch { return false; } };
    const unclassified = [];
    const writeTools = ALL_TOOLS.filter(takesSpace).filter(t => {
      const row = TOOL_RIGHTS.find(r => r.tool === t.name);
      if (row) return row.needs !== 'read';
      if (t.admin || t.spaceAdmin || t.createsSpaces) return true;
      unclassified.push(t.name);
      return false;
    });
    assert.deepEqual(unclassified, [], 'tools that take a space with neither a TOOL_RIGHTS row nor an admin/spaceAdmin/createsSpaces flag');
    assert.ok(routes.length >= 30 && writeTools.length >= 25, `derived ${routes.length} write route(s) and ${writeTools.length} write tool(s); the derivation is broken`);
    const PAYLOAD = {
      entities: { name: 'vp-w-marker', type: 'thing' }, facts: { fact: 'vp-w-marker' }, chrono: { title: 'vp-w-marker', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' },
      save_entity: { name: 'vp-w-marker', type: 'thing' }, save_fact: { fact: 'vp-w-marker' }, save_chrono: { title: 'vp-w-marker', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' },
      write_file: { path: 'vp-w-marker.txt', content: 'x' }, create_dir: { path: 'vp-w-marker' },
      rename: { newId: 'vp-renamed' }, 'network-precedence': { networks: [] },
    };
    const footprint = async () => {
      const db = (await import('../../server/dist/db/mongo.js')).getDb();
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => n.includes(QA) || n.includes(OPS)).sort();
      return Object.fromEntries(await Promise.all(names.map(async n => [n, await db.collection(n).countDocuments({})])));
    };
    const beforeFootprint = await footprint();
    const wrong = [];
    const judge = (where, text, owned) => {
      if (!text.includes(UNKNOWN('@w'))) wrong.push(`${where}: no unknown-space refusal: ${text.slice(0, 160)}`);
      else if (owned && !text.includes(HINT('@w'))) wrong.push(`${where}: the owner gets no hint`);
      else if (!owned && text.includes(HINT('@w'))) wrong.push(`${where}: a non-owner is told '@w' is a view`);
    };
    for (const r of routes) {
      // Every other parameter and the body are VALID, so the space id is the one thing a door can refuse: a door that judged the body
      // first would answer 400 for a view and an unknown space alike, and hide whether it ever looked at the id.
      const url = r.path.replace(/:spaceId\b|^(\/api\/spaces\/):id\b/, (m, p) => (p ? `${p}@w` : '@w'))
        .replace(':knowledgeType', 'entity').replace(/:\w+/g, 'x');
      const tail = r.path.split('/').pop();
      const body = PAYLOAD[tail] ?? {};
      const own = await d.rest(admin.key, r.method, url, body);
      if (own.status !== 404) wrong.push(`${r.method} ${r.path}: owner answered ${fmt(own)}`);
      judge(`${r.method} ${r.path} (owner)`, own.error, true);
    }
    for (const t of writeTools) {
      const args = { space: '@w', ...(PAYLOAD[t.name] ?? {}) };
      const m = await d.mcp(admin.key, t.name, args);
      if (!m.isError) wrong.push(`MCP ${t.name}: accepted ${m.text.slice(0, 120)}`);
      judge(`MCP ${t.name} (owner)`, m.text, true);
      const td = await d.rest(admin.key, 'POST', `/api/${t.name}`, args);
      judge(`POST /api/${t.name} (owner)`, td.error || td.text, true);
    }
    const other = await d.mint('vp-w-other', {}, { admin: true });
    judge('POST /api/brain/spaces/@w/entities (another admin)', (await d.rest(other.key, 'POST', '/api/brain/spaces/@w/entities', PAYLOAD.entities)).error, false);
    judge('MCP save_entity (another admin)', (await d.mcp(other.key, 'save_entity', { space: '@w', ...PAYLOAD.save_entity })).text, false);
    assert.deepEqual(await footprint(), beforeFootprint, 'a write door addressed to a view id changed a member\'s storage');
    assert.deepEqual(wrong, [], `${wrong.length} write door answer(s) wrong`);
    assert.ok(created.ok, `POST /api/views {name: 'w'} answered ${fmt(created.answer)}`);
  });

  it('a token with no write rung anywhere is answered the same on every door when it writes to its own view: a view, 404, with the hint', async () => {
    // `owner` holds read rungs only. The MCP dispatcher judged "this token holds no write rung in any space" BEFORE it asked whether the
    // id was a space, so the same call answered 404 + hint on the REST path route and 403 on MCP: the existence rule precedes rights on
    // every door (plan rev 3.2 "Doors and answers": the owner writing to its own view gets 404 with the hint).
    await mustCreate(owner.key, 'ro', [QA]);
    const body = { name: 'vp-ro-marker', type: 'thing' };
    const doors = {
      'REST path': await d.rest(owner.key, 'POST', '/api/brain/spaces/@ro/entities', body),
      'REST tool door': await d.rest(owner.key, 'POST', '/api/save_entity', { space: '@ro', ...body }),
      'MCP save_entity': await d.mcp(owner.key, 'save_entity', { space: '@ro', ...body }),
    };
    const wrong = [];
    for (const [where, a] of Object.entries(doors)) {
      const text = a.error || a.text;
      const status = where === 'MCP save_entity' ? (a.isError ? 404 : a.status) : a.status;
      if (status !== 404) wrong.push(`${where}: status ${a.status}: ${text.slice(0, 160)}`);
      if (!text.includes(UNKNOWN('@ro'))) wrong.push(`${where}: no unknown-space refusal: ${text.slice(0, 160)}`);
      if (!text.includes(HINT('@ro'))) wrong.push(`${where}: no hint: ${text.slice(0, 160)}`);
    }
    assert.deepEqual(wrong, [], 'a read-only token writing to its own view must meet the existence rule before its rungs are judged, on every door');
    // The control: the same token writing to a real space is still refused for its rungs, so the check above did not widen anything.
    const real = await d.mcp(owner.key, 'save_entity', { space: QA, ...body });
    assert.ok(real.isError && /write rung/.test(real.text), `a read-only token writing to a real space: ${real.text.slice(0, 160)}`);
  });

  it('the five record DELETE routes refuse a view id with the space refusal, and the member\'s record remains', async () => {
    await createView(admin.key, 'del', [QA]);
    const seed = async (route, body) => {
      const a = await d.rest(admin.key, 'POST', `/api/brain/spaces/${QA}/${route}`, body);
      assert.ok(a.status === 201 || a.status === 200, `seeding ${route}: ${fmt(a)}`);
      return a.body._id;
    };
    const from = await seed('entities', { name: 'vp-del-from', type: 'thing' });
    const to = await seed('entities', { name: 'vp-del-to', type: 'thing' });
    const factId = await seed('facts', { fact: 'vp-del-fact' });
    const ids = {
      entities: await seed('entities', { name: 'vp-del-entity', type: 'thing' }),
      facts: factId,
      edges: await seed('edges', { from, to, label: 'vp-del-rel' }),
      chrono: await seed('chrono', { title: 'vp-del-chrono', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }),
      links: await seed('links', { from: factId, fromKind: 'fact', to, toKind: 'entity' }),
    };
    const wrong = [];
    for (const [route, id] of Object.entries(ids)) {
      const a = await d.rest(admin.key, 'DELETE', `/api/brain/spaces/@del/${route}/${encodeURIComponent(id)}`);
      const still = await d.col(d.spaceCollection(QA, route)).countDocuments({ _id: id });
      if (a.status !== 404 || !a.error.includes(UNKNOWN('@del')) || !a.error.includes(HINT('@del'))) wrong.push(`DELETE ${route}: ${fmt(a)}`);
      if (still !== 1) wrong.push(`DELETE ${route}: the ${route} record in '${QA}' is GONE`);
    }
    assert.deepEqual(wrong, [], 'a record DELETE through a view id must be refused as a write to a view, before any member is walked');
  });

  it('targetSpace is refused by name, with space as its replacement, on both doors and both REST spellings, and nothing lands', async () => {
    const wrong = [];
    const byName = (text) => /targetSpace/.test(text) && /\bspace\b/.test(text.replace(/targetSpace/g, ''));
    const answers = {
      'REST query': await d.rest(admin.key, 'POST', `/api/brain/spaces/${QA}/entities?targetSpace=${QA}`, { name: 'vp-ts-query', type: 'thing' }),
      'REST body': await d.rest(admin.key, 'POST', `/api/brain/spaces/${QA}/entities`, { name: 'vp-ts-body', type: 'thing', targetSpace: QA }),
    };
    for (const [where, a] of Object.entries(answers)) if (a.status !== 400 || !byName(a.error)) wrong.push(`${where}: ${fmt(a)}`);
    const m = await d.mcp(admin.key, 'save_entity', { space: QA, targetSpace: QA, name: 'vp-ts-mcp', type: 'thing' });
    if (!m.isError || !byName(m.text)) wrong.push(`MCP: ${m.text.slice(0, 200)}`);
    const landed = await d.col(d.spaceCollection(QA, 'entities')).countDocuments({ name: { $in: ['vp-ts-query', 'vp-ts-body', 'vp-ts-mcp'] } });
    if (landed) wrong.push(`${landed} entity(ies) landed`);
    assert.deepEqual(wrong, []);
  });

  it('proxyFor on POST /api/spaces and save_space is refused by name with its replacement, and no space is created', async () => {
    const rest = await d.rest(admin.key, 'POST', '/api/spaces', { id: 'vp-px-rest', label: 'px', proxyFor: [QA] });
    const m = await d.mcp(admin.key, 'save_space', { id: 'vp-px-mcp', label: 'px', proxyFor: [QA] });
    const wrong = [];
    if (rest.status !== 400 || !/proxyFor/.test(rest.error) || !/POST \/api\/views/.test(rest.error)) wrong.push(`REST: ${fmt(rest)}`);
    if (!m.isError || !/proxyFor/.test(m.text) || !/view_create/.test(m.text)) wrong.push(`MCP: ${m.text.slice(0, 200)}`);
    const made = d.loader.getConfig().spaces.filter(s => s.id === 'vp-px-rest' || s.id === 'vp-px-mcp').map(s => s.id);
    if (made.length) wrong.push(`created: ${made}`);
    assert.deepEqual(wrong, []);
  });

  // b100 lens S2: the body-scoped guard expanded a view whatever its area and rung, so a write route mounted on it would have written
  // to the view's members. Every (area, rung) the guard can be built for that does not take a view must answer the view as a space
  // that is not one, with the hint, and never reach the handler.
  it('the body-scoped guard expands a view only for an area and rung that take a view', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { requireBodyScopedSpace } = await import('../../server/dist/auth/middleware.js');
    const { takesAView } = await import('../../server/dist/auth/space-rights.js');
    const { RUNGS } = await import('../../server/dist/config/rights-shape.js');
    const writer = await d.mint('vp-body-writer', { [QA]: d.row({}, 'admin'), [OPS]: d.row({}, 'admin') });
    await mustCreate(writer.key, 'body', [QA, OPS]);
    const pairs = d.SPACE_AREAS.flatMap(area => RUNGS.filter(r => r !== 'none').map(needs => ({ area, needs })));
    const refusing = pairs.filter(p => !takesAView(p));
    assert.ok(refusing.length >= 2 && pairs.length > refusing.length, `derived ${refusing.length} of ${pairs.length} (area, rung) pairs as not taking a view`);
    const app = express();
    app.use(express.json());
    const reached = [];
    for (const p of pairs) {
      app.post(`/probe/${p.area}/${p.needs}`, requireBodyScopedSpace(p.area, p.needs), (req, res) => { reached.push(`${p.area}/${p.needs}`); res.json({ spaces: req.authorisedSpaces }); });
    }
    const { listenOnLoopback } = await import('../_shared/local-server.mjs');
    const server = await listenOnLoopback(http.createServer(app));
    const url = server.url;
    try {
      const wrong = [];
      for (const p of pairs) {
        const r = await fetch(`${url}/probe/${p.area}/${p.needs}`, {
          method: 'POST', headers: { Authorization: `Bearer ${writer.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space: '@body' }),
        });
        const body = await r.json().catch(() => ({}));
        if (takesAView(p)) {
          if (r.status !== 200) wrong.push(`${p.area}/${p.needs}: a read that takes a view answered ${r.status} ${JSON.stringify(body)}`);
        } else if (r.status !== 404 || !String(body.error ?? '').includes(HINT('@body'))) {
          wrong.push(`${p.area}/${p.needs}: ${r.status} ${JSON.stringify(body).slice(0, 160)}`);
        }
      }
      assert.deepEqual(wrong, []);
      assert.deepEqual(reached.filter(k => refusing.some(p => `${p.area}/${p.needs}` === k)), [], 'a body-scoped route that does not take a view reached its handler with a view');
    } finally { await server.close(); }
  });
});
