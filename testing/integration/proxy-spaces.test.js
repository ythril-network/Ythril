/**
 * Integration tests: personal views (Q-531, 6.0) - the contract that replaced the proxy space.
 *
 * (The file keeps its name, which the surface-matrix and the board refer to; a proxy is a personal view now.)
 *
 * Covers:
 *  - A view is made by `POST /api/views`, listed by `GET /api/views`, and is NOT a space (absent from `GET /api/spaces`)
 *  - `proxyFor` is retired on `POST /api/spaces`, refused by name with the view door as its replacement
 *  - A view lists spaces only: another view and a missing space are refused
 *  - Brain reads aggregate across the members the caller reads, and the answer says which it read (`viewMembers`)
 *  - Every write door answers a view id as an unknown space; `targetSpace` is refused by name (query and body)
 *  - Files: a listing aggregates across members; every file write to a view is refused
 *  - MCP: `filter`, `list_dir` and `read_file` read through `@view`; `save_fact` refuses it; `view_list` mirrors the REST door
 *  - Deleting a view deletes no data; deleting a member space drops it from the view
 *
 * Run: node --test testing/integration/proxy-spaces.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson, readCollection } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const BASE = INSTANCES.a;

let tokenA;
const RUN = `px${Date.now()}`;
const SPACE_A = `${RUN}-alpha`;
const SPACE_B = `${RUN}-beta`;
const NAME = `${RUN}-team`;
const VIEW = `@${NAME}`;
const VIEW_URL = encodeURIComponent(VIEW);

function patch(baseUrl, token, urlPath, data) {
  return reqJson(baseUrl, token, urlPath, { method: 'PATCH', body: JSON.stringify(data) });
}

describe('Personal views', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    for (const [id, label] of [[SPACE_A, 'Alpha'], [SPACE_B, 'Beta']]) {
      const r = await post(BASE, tokenA, '/api/spaces', { id, label, meta: { strictLinkage: false } });
      assert.equal(r.status, 201, `Create ${id}: ${JSON.stringify(r.body)}`);
    }
    const v = await post(BASE, tokenA, '/api/views', { name: NAME, members: [SPACE_A, SPACE_B] });
    assert.equal(v.status, 201, `Create view: ${JSON.stringify(v.body)}`);
    assert.equal(v.body.view.id, VIEW);
  });

  after(async () => {
    await del(BASE, tokenA, `/api/views/${VIEW_URL}`).catch(() => {});
    for (const id of [SPACE_A, SPACE_B]) await delWithBody(BASE, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  });

  describe('creation and listing', () => {
    it('a view is listed with the members the caller reads, and is not a space', async () => {
      const v = await get(BASE, tokenA, '/api/views');
      assert.equal(v.status, 200);
      const mine = v.body.views.find(x => x.id === VIEW);
      assert.ok(mine, 'the view should be listed');
      assert.deepEqual([...mine.members].sort(), [SPACE_A, SPACE_B].sort());
      assert.deepEqual([...mine.readable].sort(), [SPACE_A, SPACE_B].sort());
      const spaces = await get(BASE, tokenA, '/api/spaces');
      assert.equal(spaces.body.spaces.some(s => s.id === VIEW), false, 'a view must not be in the space list');
    });

    it('proxyFor is refused by name, pointing at the view door, and no space is created', async () => {
      const r = await post(BASE, tokenA, '/api/spaces', { id: `${RUN}-old`, label: 'Old proxy', proxyFor: [SPACE_A] });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /proxyFor/);
      assert.match(r.body.error, /POST \/api\/views/);
      const spaces = await get(BASE, tokenA, '/api/spaces');
      assert.equal(spaces.body.spaces.some(s => s.id === `${RUN}-old`), false);
    });

    it('a view lists spaces only: another view, and a space that does not exist, are refused', async () => {
      const nested = await post(BASE, tokenA, '/api/views', { name: `${RUN}-nested`, members: [VIEW] });
      assert.equal(nested.status, 400, JSON.stringify(nested.body));
      const missing = await post(BASE, tokenA, '/api/views', { name: `${RUN}-bad`, members: ['does-not-exist-99'] });
      assert.equal(missing.status, 404, JSON.stringify(missing.body));
      assert.match(missing.body.error, /not found/i);
    });
  });

  describe('Brain - reads aggregate, writes refuse', () => {
    let factA;

    before(async () => {
      const a = await post(BASE, tokenA, `/api/brain/spaces/${SPACE_A}/facts`, { fact: 'Alpha fact', tags: ['alpha'] });
      assert.equal(a.status, 201, JSON.stringify(a.body));
      factA = a.body._id;
      const b = await post(BASE, tokenA, `/api/brain/spaces/${SPACE_B}/facts`, { fact: 'Beta fact', tags: ['beta'] });
      assert.equal(b.status, 201, JSON.stringify(b.body));
    });

    it('listing through the view aggregates both members and names the members it read', async () => {
      // A body names the view as it is spelled; only a URL path takes the encoded form.
      const r = await readCollection(BASE, tokenA, VIEW, 'facts', { limit: 100 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const facts = r.results.map(m => m.fact);
      assert.ok(facts.includes('Alpha fact') && facts.includes('Beta fact'), `both members are read: ${facts}`);
      assert.deepEqual([...r.body.viewMembers].sort(), [SPACE_A, SPACE_B].sort());
    });

    it('stats sum across the members', async () => {
      const r = await get(BASE, tokenA, `/api/brain/spaces/${VIEW_URL}/stats`);
      assert.equal(r.status, 200);
      assert.ok(r.body.facts >= 2, `Expected facts >= 2, got ${r.body.facts}`);
    });

    it('a write through the view answers as an unknown space, with the owner-only hint, and writes nothing', async () => {
      const r = await post(BASE, tokenA, `/api/brain/spaces/${VIEW_URL}/facts`, { fact: 'Should fail' });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.match(r.body.error, /not found/i);
      assert.match(r.body.error, /is a view; write to one of its member spaces/);
      const all = await readCollection(BASE, tokenA, SPACE_A, 'facts', { limit: 100 });
      assert.equal(all.results.some(m => m.fact === 'Should fail'), false);
    });

    it('a delete through the view is refused and the record stays', async () => {
      const r = await del(BASE, tokenA, `/api/brain/spaces/${VIEW_URL}/facts/${factA}`);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      // A record is read through filter: the by-id GETs are gone.
      const still = await readCollection(BASE, tokenA, SPACE_A, 'facts', { filter: { _id: factA } });
      assert.equal(still.status, 200, JSON.stringify(still.body));
      assert.deepEqual(still.results.map(m => m._id), [factA], 'the record must still be in its member space');
    });

    it('the retired targetSpace is refused by name on a write, in the query and in the body', async () => {
      const query = await post(BASE, tokenA, `/api/brain/spaces/${SPACE_A}/facts?targetSpace=${SPACE_B}`, { fact: 'Should fail' });
      assert.equal(query.status, 400, JSON.stringify(query.body));
      assert.match(query.body.error, /targetSpace/);
      const body = await post(BASE, tokenA, `/api/brain/spaces/${SPACE_A}/facts`, { fact: 'Should fail', targetSpace: SPACE_B });
      assert.equal(body.status, 400, JSON.stringify(body.body));
      assert.match(body.body.error, /targetSpace/);
    });

    it('reindex-status reads through the view, and a reindex of the view id is an unknown space', async () => {
      const r = await get(BASE, tokenA, `/api/brain/spaces/${VIEW_URL}/reindex-status`);
      assert.equal(r.status, 200);
      assert.equal(typeof r.body.needsReindex, 'boolean');
      const re = await post(BASE, tokenA, `/api/brain/spaces/${VIEW_URL}/reindex`, {});
      assert.equal(re.status, 404, JSON.stringify(re.body));
    });
  });

  describe('Files', () => {
    before(async () => {
      for (const [space, name] of [[SPACE_A, 'view-alpha.txt'], [SPACE_B, 'view-beta.txt']]) {
        const r = await post(BASE, tokenA, `/api/files/${space}?path=${name}`, { content: `${name} content`, encoding: 'utf8' });
        assert.ok([201, 202].includes(r.status), JSON.stringify(r.body));
      }
    });

    it('a root listing through the view aggregates the entries of both members', async () => {
      const r = await get(BASE, tokenA, `/api/files/${VIEW_URL}`);
      assert.equal(r.status, 200);
      const names = r.body.entries.map(e => e.name);
      assert.ok(names.includes('view-alpha.txt') && names.includes('view-beta.txt'), `listing: ${names}`);
    });

    it('a file is found across the members', async () => {
      const resp = await fetch(`${BASE}/api/files/${VIEW_URL}?path=view-alpha.txt`, { headers: { Authorization: `Bearer ${tokenA}` } });
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), 'view-alpha.txt content');
    });

    it('every file write through the view is an unknown space: upload, mkdir, delete, move', async () => {
      const upload = await post(BASE, tokenA, `/api/files/${VIEW_URL}?path=nope.txt`, { content: 'x', encoding: 'utf8' });
      const mkdir = await post(BASE, tokenA, `/api/files/${VIEW_URL}/mkdir?path=newdir`, {});
      const remove = await del(BASE, tokenA, `/api/files/${VIEW_URL}?path=view-alpha.txt`);
      const move = await patch(BASE, tokenA, `/api/files/${VIEW_URL}?path=view-beta.txt`, { destination: 'renamed.txt' });
      for (const [what, r] of [['upload', upload], ['mkdir', mkdir], ['delete', remove], ['move', move]]) {
        assert.equal(r.status, 404, `${what} through a view: ${r.status} ${JSON.stringify(r.body)}`);
      }
    });
  });

  describe('MCP', () => {
    let session;
    before(async () => { session = await openMcpSession(tokenA); });

    it('filter reads through the view and says which members it read', async () => {
      const r = await session.callTool('filter', { space: VIEW, collection: 'facts', filter: {} });
      assert.ok(!r?.isError, JSON.stringify(r));
      assert.deepEqual([...r.structuredContent.viewMembers].sort(), [SPACE_A, SPACE_B].sort());
      const facts = (r.structuredContent.results ?? []).map(m => m.fact);
      assert.ok(facts.includes('Alpha fact') && facts.includes('Beta fact'), `facts: ${facts}`);
    });

    it('list_dir and read_file read through the view', async () => {
      const ls = await session.callTool('list_dir', { space: VIEW });
      assert.ok(!ls?.isError, JSON.stringify(ls));
      assert.ok(ls.content[0].text.includes('view-alpha.txt') && ls.content[0].text.includes('view-beta.txt'));
      const read = await session.callTool('read_file', { space: VIEW, path: 'view-beta.txt' });
      assert.ok(!read?.isError, JSON.stringify(read));
      assert.ok(read.content[0].text.includes('view-beta.txt content'));
    });

    it('save_fact and write_file refuse the view id as an unknown space', async () => {
      const fact = await session.callTool('save_fact', { space: VIEW, fact: 'Should fail' });
      assert.ok(fact?.isError, JSON.stringify(fact));
      assert.match(fact.content[0].text, /not found/i);
      const file = await session.callTool('write_file', { space: VIEW, path: 'nope.txt', content: 'x' });
      assert.ok(file?.isError, JSON.stringify(file));
    });

    it('a retired targetSpace is refused by name', async () => {
      const r = await session.callTool('save_fact', { space: SPACE_A, targetSpace: SPACE_B, fact: 'Should fail' });
      assert.ok(r?.isError, JSON.stringify(r));
      assert.match(r.content[0].text, /targetSpace/);
    });

    it('view_list mirrors GET /api/views', async () => {
      const r = await session.callTool('view_list', {});
      assert.ok(!r?.isError, JSON.stringify(r));
      assert.ok(r.structuredContent.views.some(v => v.id === VIEW));
    });
  });

  describe('lifecycle', () => {
    it('deleting a member space drops it from the view, and deleting the view deletes no data', async () => {
      const spare = `${RUN}-spare`;
      assert.equal((await post(BASE, tokenA, '/api/spaces', { id: spare, label: 'Spare' })).status, 201);
      const made = await post(BASE, tokenA, '/api/views', { name: `${RUN}-life`, members: [SPACE_A, spare] });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const gone = await delWithBody(BASE, tokenA, `/api/spaces/${spare}`, { confirm: true });
      assert.ok([200, 202, 204].includes(gone.status), `delete the member: ${gone.status} ${JSON.stringify(gone.body)}`);
      const list = await get(BASE, tokenA, '/api/views');
      const life = list.body.views.find(v => v.id === `@${RUN}-life`);
      assert.deepEqual(life.members, [SPACE_A], 'a deleted space must leave the views that listed it');
      const removed = await del(BASE, tokenA, `/api/views/${encodeURIComponent(`@${RUN}-life`)}`);
      assert.equal(removed.status, 204);
      const facts = await readCollection(BASE, tokenA, SPACE_A, 'facts', { limit: 100 });
      assert.ok(facts.results.length >= 1, 'deleting a view must not touch the data of a member');
    });
  });
});
