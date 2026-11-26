/**
 * A personal view may carry a SPARQL CONSTRUCT query, and it is saved only as one, on both doors (bundle-273, Q-762).
 *
 * ## The rules
 *
 * 1. **A CONSTRUCT is accepted and shown.** `sparql: { query }` on `POST /api/views` and MCP `view_create` saves it; the answer, `GET
 *    /api/views/:id`, `GET /api/views`, `view_get` and `view_list` show it as `sparql: { query }`. `PATCH /api/views/:id` and `view_update`
 *    set it, and `sparql: null` takes it off (the view is a plain one again).
 * 2. **Anything else is refused with its reason, saving nothing**, alike on both doors: a SELECT, an ASK or a DESCRIBE is
 *    `400 view_sparql_not_construct`, a SPARQL Update is `400 view_sparql_not_construct`, a text no parser reads is `400 view_sparql_invalid`,
 *    a text over 16 384 bytes is `400 view_sparql_too_large` (16 384 bytes exactly is saved), and a `sparql` that is no `{ query: <text> }` is `400 view_sparql_invalid`.
 * 3. **A copy carries the query.** `view_copy` (and `POST /api/views/:id/copy`) gives the receiver a view with the same `sparql`.
 * 4. **A plain view is answered as before**: no `sparql` key on it.
 *
 * ## Seen red on 9f5d8d295
 *
 * Rule 1: `REST create answers the query` (actual `undefined`: the field was dropped); rules 2 and 3 failed alike (the query was neither
 * judged nor carried).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-view-is-saved-only-as-a-construct-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { viewOf, viewsOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const S = 'q762-save';
const KEEP_ENTITIES = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s a <https://w3id.org/ythril/ns#Entity> ; ?p ?o }';
/** `KEEP_ENTITIES` and a comment, `bytes` UTF-8 bytes long in all. */
function padded(bytes) {
  const head = `${KEEP_ENTITIES}\n# `;
  return `${head}${'x'.repeat(bytes - Buffer.byteLength(head, 'utf8'))}`;
}
const REFUSED = [
  ['a SELECT', 'SELECT ?s WHERE { ?s ?p ?o }', 'view_sparql_not_construct'],
  ['an ASK', 'ASK { ?s ?p ?o }', 'view_sparql_not_construct'],
  ['a DESCRIBE', 'DESCRIBE <urn:x:a>', 'view_sparql_not_construct'],
  ['an Update', 'INSERT DATA { <urn:x:a> <urn:x:b> <urn:x:c> }', 'view_sparql_not_construct'],
  ['a text no parser reads', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p', 'view_sparql_invalid'],
  // 16 384 bytes and one more: a CONSTRUCT whose comment carries the rest.
  ['a text of 16 385 bytes', padded(16 * 1024 + 1), 'view_sparql_too_large'],
];

let d, owner, receiver;
const codeOf = (a) => a.body?.code ?? a.structured?.code ?? /\b(view_[a-z_]+)\b/.exec(a.text ?? '')?.[1];
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
/**
 * A tool call answered by the message that answers it: `view_create` and `view_update` stream `notifications/tools/list_changed` before
 * their result, so the first message of the answer is not the result.
 */
async function tool(key, name, args) {
  const r = await d.rpc(key, 'tools/call', { name, arguments: args });
  const res = r.result?.result;
  const text = (res?.content ?? []).map(c => c.text ?? '').join('\n') || r.result?.error?.message || '';
  return { isError: res?.isError === true || !!r.result?.error, text, structured: res?.structuredContent ?? null };
}

describe('a SPARQL view is saved only as a CONSTRUCT, on both doors', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q762-save', spaces: [{ id: S }] });
    owner = await d.mint('q762-save-owner', { [S]: d.row({ knowledge: 'read' }) });
    receiver = await d.mint('q762-save-receiver', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a CONSTRUCT is saved and shown on REST and MCP; PATCH sets it and null takes it off', async () => {
    const made = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-rest', members: [S], sparql: { query: KEEP_ENTITIES } });
    assert.equal(made.status, 201, fmt(made));
    assert.deepEqual(viewOf(made).sparql, { query: KEEP_ENTITIES }, 'REST create answers the query');
    const got = await d.rest(owner.key, 'GET', '/api/views/@q762-rest');
    assert.deepEqual(viewOf(got).sparql, { query: KEEP_ENTITIES }, 'GET /api/views/:id shows the query');
    const listed = viewsOf(await d.rest(owner.key, 'GET', '/api/views')).find(v => v.id === '@q762-rest');
    assert.deepEqual(listed?.sparql, { query: KEEP_ENTITIES }, 'GET /api/views shows the query');

    const viaMcp = await tool(owner.key, 'view_create', { name: 'q762-mcp', members: [S], sparql: { query: KEEP_ENTITIES } });
    assert.equal(viaMcp.isError, false, viaMcp.text.slice(0, 300));
    assert.deepEqual(viewOf(viaMcp).sparql, { query: KEEP_ENTITIES }, 'view_create answers the query');
    const mcpListed = viewsOf(await d.mcp(owner.key, 'view_list', {})).find(v => v.id === '@q762-mcp');
    assert.deepEqual(mcpListed?.sparql, { query: KEEP_ENTITIES }, 'view_list shows the query');
    const mcpGot = await d.mcp(owner.key, 'view_get', { view: '@q762-mcp' });
    assert.deepEqual(viewOf(mcpGot).sparql, { query: KEEP_ENTITIES }, 'view_get shows the query');

    const plain = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-plain', members: [S] });
    assert.equal(plain.status, 201, fmt(plain));
    assert.equal('sparql' in viewOf(plain), false, 'a plain view carries no sparql key');
    const other = 'CONSTRUCT { ?s <urn:x:seen> true } WHERE { ?s ?p ?o }';
    const patched = await d.rest(owner.key, 'PATCH', '/api/views/@q762-plain', { sparql: { query: other } });
    assert.equal(patched.status, 200, fmt(patched));
    assert.deepEqual(viewOf(patched).sparql, { query: other }, 'PATCH sets the query');
    const updated = await tool(owner.key, 'view_update', { view: '@q762-plain', sparql: null });
    assert.equal(updated.isError, false, updated.text.slice(0, 300));
    assert.equal('sparql' in viewOf(updated), false, 'view_update with sparql: null makes it a plain view again');
    assert.equal('sparql' in viewOf(await d.rest(owner.key, 'GET', '/api/views/@q762-plain')), false, 'and it stays plain');
  });

  it('a CONSTRUCT of exactly 16 384 bytes is saved on create and update, on both doors', async () => {
    const query = padded(16 * 1024);
    assert.equal(Buffer.byteLength(query, 'utf8'), 16 * 1024);
    const restCreate = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-exact-rest', members: [S], sparql: { query } });
    assert.equal(restCreate.status, 201, fmt(restCreate));
    const mcpCreate = await tool(owner.key, 'view_create', { name: 'q762-exact-mcp', members: [S], sparql: { query } });
    assert.equal(mcpCreate.isError, false, mcpCreate.text.slice(0, 300));
    const restPatch = await d.rest(owner.key, 'PATCH', '/api/views/@q762-exact-rest', { sparql: { query: `${query}\n#` } });
    assert.equal(restPatch.status, 400, `REST update with two bytes more: ${fmt(restPatch)}`);
    assert.equal(codeOf(restPatch), 'view_sparql_too_large');
    const mcpPatch = await tool(owner.key, 'view_update', { view: '@q762-exact-mcp', sparql: { query } });
    assert.equal(mcpPatch.isError, false, mcpPatch.text.slice(0, 300));
  });

  it('a SELECT, an ASK, a DESCRIBE, an Update, a broken text and one over 16 KB are refused alike on create and update, on both doors', async () => {
    const base = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-target', members: [S] });
    assert.equal(base.status, 201, fmt(base));
    for (const [what, query, code] of REFUSED) {
      const restCreate = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-refused', members: [S], sparql: { query } });
      assert.equal(restCreate.status, 400, `${what}, REST create: ${fmt(restCreate)}`);
      assert.equal(codeOf(restCreate), code, `${what}, REST create: ${fmt(restCreate)}`);
      const mcpCreate = await tool(owner.key, 'view_create', { name: 'q762-refused', members: [S], sparql: { query } });
      assert.equal(mcpCreate.isError, true, `${what}, MCP create was saved`);
      assert.equal(codeOf(mcpCreate), code, `${what}, MCP create: ${mcpCreate.text.slice(0, 300)}`);
      const restPatch = await d.rest(owner.key, 'PATCH', '/api/views/@q762-target', { sparql: { query } });
      assert.equal(restPatch.status, 400, `${what}, REST update: ${fmt(restPatch)}`);
      assert.equal(codeOf(restPatch), code, `${what}, REST update`);
      const mcpPatch = await tool(owner.key, 'view_update', { view: '@q762-target', sparql: { query } });
      assert.equal(mcpPatch.isError, true, `${what}, MCP update was saved`);
      assert.equal(codeOf(mcpPatch), code, `${what}, MCP update: ${mcpPatch.text.slice(0, 300)}`);
    }
    for (const bad of [{ text: KEEP_ENTITIES }, 'CONSTRUCT {} WHERE {}', { query: 7 }]) {
      const r = await d.rest(owner.key, 'POST', '/api/views', { name: 'q762-refused', members: [S], sparql: bad });
      assert.equal(r.status, 400, `sparql ${JSON.stringify(bad)}: ${fmt(r)}`);
      assert.equal(codeOf(r), 'view_sparql_invalid', `sparql ${JSON.stringify(bad)}`);
    }
    const names = viewsOf(await d.rest(owner.key, 'GET', '/api/views')).map(v => v.id);
    assert.ok(!names.includes('@q762-refused'), 'a refused create saved a view');
    assert.equal('sparql' in viewOf(await d.rest(owner.key, 'GET', '/api/views/@q762-target')), false, 'a refused update saved a query');
  });

  it('a copy carries the query to its receiver', async () => {
    const admin = await d.mint('q762-save-admin', {}, { admin: true });
    const made = await d.rest(admin.key, 'POST', '/api/views', { name: 'q762-given', members: [S], sparql: { query: KEEP_ENTITIES } });
    assert.equal(made.status, 201, fmt(made));
    const given = await d.mcp(admin.key, 'view_copy', { view: '@q762-given', toTokenId: receiver.id });
    assert.equal(given.isError, false, given.text.slice(0, 300));
    const theirs = viewsOf(await d.rest(receiver.key, 'GET', '/api/views')).find(v => v.name.startsWith('q762-given'));
    assert.deepEqual(theirs?.sparql, { query: KEEP_ENTITIES }, 'the receiver\'s copy has the query');
  });
});
