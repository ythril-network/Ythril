/**
 * The `unknownWriteFields` setting is SET, REFUSED when invalid, GOVERNED by its rung and applied to a proxy write alike on both doors —
 * `PATCH /api/spaces/:id` and `update_space` — and a networked space applies it at once while the rest of the PATCH waits for its vote
 * (bundle-128, Q-320; design-v3 section 1.1, section 8.1 case (o), gate G13).
 *
 * ## What it prevents
 *
 * One setting, two doors, and each door was written by hand. The defects this file is the net for, each one a door answering differently:
 *
 * - **A value one door accepts and the other refuses.** The body is `'warn' | 'refuse' | '' | null`; anything else is a 400 on BOTH doors,
 *   and `null` and `''` are accepted by `update_space`'s Ajv as they are by REST's zod — a client sends `''` to clear (the Settings save's
 *   `clearedValueOf`), so a door that refused it would make the setting impossible to turn off from that client.
 * - **A cleared key that is falsy and not absent.** Absent, `'warn'`, `''` and `null` are ONE state (the default); a key left as `''` or
 *   `undefined` on the space would be a second state the audit and the read path then disagree about.
 * - **A weaker rung on one door.** REST charges the field at `schema:admin` (it makes writes that succeeded start failing); `update_space`
 *   stays `spaceAdmin`, which is stricter and applies to every `update_space` argument. Neither may be weaker than its stated rung.
 * - **A networked space dropping it.** A meta change on a networked space answers `vote_pending` BEFORE the setting would be applied, so a
 *   PATCH carrying both silently lost the key (finding DI1). The key is local and never voted: it is applied before the vote branch.
 * - **A proxy governing a write.** A write through a proxy lands in a member; the MEMBER's setting governs, on both doors, never the proxy's own.
 *
 * ## Red on the unchanged base
 *
 * `UpdateSpaceBody` is strict and does not list the key; `update_space`'s schema is closed and does not declare it; so every accepted case
 * is a 400 on both doors, and the invalid-value cases are refused for the wrong reason (an unknown key), which the assertions on the stored
 * state and on the named setting catch.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-unknown-write-fields-setting-is-set-refused-and-governed-alike-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const A = 'b128-set-a';
const NET_SPACE = 'b128-set-net';
const REFUSING = 'b128-set-refusing';
const WARNING = 'b128-set-warning';
const PROXY = 'b128-set-proxy';
const NET = 'b128-set-network';
const SELF = '00000000-0000-4000-8000-0000000000e0';
const P1 = '00000000-0000-4000-8000-0000000000e1';
const P2 = '00000000-0000-4000-8000-0000000000e2';
const member = (instanceId) => ({
  instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both',
});

let door, server, base, adminKey, callTool, getConfig, SPACE_AREAS, ADMIN;

async function rest(method, route, body, key = adminKey) {
  const r = await fetch(`${base}${route}`, {
    method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const patch = (space, body, key) => rest('PATCH', `/api/spaces/${space}`, body, key);

/** A tool through `callTool`, the dispatch every MCP request goes through, as a caller holding `rights`. */
async function mcp(name, args, rights = ADMIN) {
  const out = await callTool({
    name, args,
    caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
  });
  return { refused: out.result.isError === true, status: out.status, text: (out.result.content ?? []).map(c => c.text ?? '').join('\n'), structured: out.result.structuredContent };
}
const spaceOf = (id) => getConfig().spaces.find(s => s.id === id);
/** The mode the stored value means: only the stored `'refuse'` refuses. Read from the config, never from a response. */
const stored = (id) => (Object.hasOwn(spaceOf(id), 'unknownWriteFields') ? spaceOf(id).unknownWriteFields : '(absent)');

/** Rights with `schema` at `rung` on one space and nothing anywhere else. */
const rightsAt = (space, rung) => ({
  instanceAdmin: false, createSpaces: false, floor: null,
  perSpace: { [space]: Object.fromEntries(SPACE_AREAS.map(a => [a, a === 'schema' ? rung : 'none'])) },
});
/** Rights that administer one space outright (the `spaceAdmin` rung). */
const spaceAdminOf = (space) => ({
  instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: [space] },
});

describe('the unknownWriteFields setting is set, refused and governed alike on both doors', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'b128-contract-setting',
      spaces: [
        { id: A, label: A, folders: [], meta: { suppressEmbeddings: true } },
        { id: NET_SPACE, label: NET_SPACE, folders: [], meta: { purpose: 'original', version: 1, updatedAt: '2026-10-01T00:00:00.000Z' } },
        { id: REFUSING, label: REFUSING, folders: [], meta: { suppressEmbeddings: true }, unknownWriteFields: 'refuse' },
        { id: WARNING, label: WARNING, folders: [], meta: { suppressEmbeddings: true } },
        // The proxy's own stored value must govern nothing: the member's does.
        { id: PROXY, label: PROXY, folders: [], meta: {}, proxyFor: [REFUSING, WARNING], unknownWriteFields: 'refuse' },
      ],
      networks: [{
        id: NET, label: 'Net', type: 'democratic', origin: 'created', syncSchedule: '', spaces: [NET_SPACE], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1), member(P2)], pendingRounds: [],
      }],
    });
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'b128-set-admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await door?.close();
  });
  beforeEach(async () => {
    for (const s of [REFUSING, WARNING]) await door.coll(s, 'entities').deleteMany({});
    // Back to the fixture: A absent, REFUSING and PROXY refuse, WARNING absent.
    delete spaceOf(A).unknownWriteFields;
    delete spaceOf(NET_SPACE).unknownWriteFields;
    delete spaceOf(WARNING).unknownWriteFields;
    spaceOf(REFUSING).unknownWriteFields = 'refuse';
    spaceOf(PROXY).unknownWriteFields = 'refuse';
  });

  // ── the value ────────────────────────────────────────────────────────────────────────────────────────────────────

  it('refuse is accepted and stored on both doors, and the key alone counts as asking for something', async () => {
    const viaRest = await patch(A, { unknownWriteFields: 'refuse' });
    assert.equal(viaRest.status, 200, `REST refused the key alone: ${viaRest.text}`);
    assert.equal(stored(A), 'refuse');
    delete spaceOf(A).unknownWriteFields;
    const viaMcp = await mcp('update_space', { space: A, unknownWriteFields: 'refuse' });
    assert.equal(viaMcp.refused, false, `update_space refused the key: ${viaMcp.text}`);
    assert.equal(stored(A), 'refuse', 'both doors store the same thing');
  });

  const INVALID = [['an unknown word', 'sometimes'], ['a number', 7], ['true', true], ['an object', { refuse: true }], ['an array', ['refuse']], ['REFUSE in capitals', 'REFUSE']];
  for (const [label, value] of INVALID) {
    it(`${label} is refused on both doors with a 400 that names the setting, and nothing is stored`, async () => {
      const viaRest = await patch(A, { unknownWriteFields: value });
      const viaMcp = await mcp('update_space', { space: A, unknownWriteFields: value });
      assert.equal(viaRest.status, 400, `REST answered ${viaRest.status}: ${viaRest.text}`);
      assert.equal(viaMcp.status, 400, `update_space answered ${viaMcp.status}: ${viaMcp.text}`);
      assert.equal(viaMcp.refused, true);
      for (const [door_, text] of [['REST', viaRest.text], ['update_space', viaMcp.text]]) {
        assert.ok(text.includes('unknownWriteFields'), `${door_} refused without naming the setting (it may have refused the key itself as unknown): ${text}`);
        assert.ok(!/unexpected property|unrecognized key/i.test(text), `${door_} refused the setting as an unknown key: ${text}`);
      }
      assert.equal(stored(A), '(absent)', 'a refused value changed the stored setting');
    });
  }

  for (const clear of [null, '', 'warn']) {
    it(`${JSON.stringify(clear)} is accepted on both doors, clears the setting, and leaves the key ABSENT (not falsy)`, async () => {
      for (const set of [() => patch(A, { unknownWriteFields: 'refuse' }), () => mcp('update_space', { space: A, unknownWriteFields: 'refuse' })]) {
        await set();
        assert.equal(stored(A), 'refuse', 'fixture: the space must refuse before it is cleared');
        const viaRest = await patch(A, { unknownWriteFields: clear });
        assert.equal(viaRest.status, 200, `REST refused ${JSON.stringify(clear)}: ${viaRest.text}`);
        assert.equal(stored(A), '(absent)', `after REST ${JSON.stringify(clear)} the key is ${JSON.stringify(stored(A))}`);

        await set();
        assert.equal(stored(A), 'refuse');
        const viaMcp = await mcp('update_space', { space: A, unknownWriteFields: clear });
        assert.equal(viaMcp.refused, false, `update_space's Ajv refused ${JSON.stringify(clear)}: ${viaMcp.text}`);
        assert.equal(stored(A), '(absent)', `after update_space ${JSON.stringify(clear)} the key is ${JSON.stringify(stored(A))}`);
      }
    });
  }

  it('update_space with nothing to update says so in a sentence that names the new key', async () => {
    const r = await mcp('update_space', { space: A });
    assert.equal(r.refused, true);
    assert.ok(r.text.includes('unknownWriteFields'), `the nothing-to-update refusal does not list the key an operator can send: ${r.text}`);
  });

  // ── the rung ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it('REST charges the key at schema:admin: admin may set it, write may not, and the refusal leaves it unchanged', async () => {
    const tokens = await import('../../server/dist/auth/tokens.js');
    const admin = (await tokens.createToken({ name: 'schema-admin', rights: rightsAt(A, 'admin') })).plaintext;
    const writer = (await tokens.createToken({ name: 'schema-write', rights: rightsAt(A, 'write') })).plaintext;
    const denied = await patch(A, { unknownWriteFields: 'refuse' }, writer);
    assert.equal(denied.status, 403, `a schema:write token changed a setting that makes writes start failing: ${denied.text}`);
    assert.equal(stored(A), '(absent)');
    const allowed = await patch(A, { unknownWriteFields: 'refuse' }, admin);
    assert.equal(allowed.status, 200, `a schema:admin token was refused: ${allowed.text}`);
    assert.equal(stored(A), 'refuse');
  });

  it('update_space stays at spaceAdmin: schema:admin alone is refused, the space\'s administrator is let through', async () => {
    const schemaAdminOnly = await mcp('update_space', { space: A, unknownWriteFields: 'refuse' }, rightsAt(A, 'admin'));
    assert.equal(schemaAdminOnly.refused, true, 'schema:admin alone reached update_space, which applies to every argument at spaceAdmin');
    assert.equal(schemaAdminOnly.status, 403, schemaAdminOnly.text);
    assert.equal(stored(A), '(absent)');
    const spaceAdmin = await mcp('update_space', { space: A, unknownWriteFields: 'refuse' }, spaceAdminOf(A));
    assert.equal(spaceAdmin.refused, false, `a space administrator was refused: ${spaceAdmin.text}`);
    assert.equal(stored(A), 'refuse');
  });

  // ── a networked space applies it now ─────────────────────────────────────────────────────────────────────────────

  it('G13: a networked PATCH carrying a meta change and the key stores the key at once on REST and on update_space, and still answers vote_pending for the meta', async () => {
    const viaRest = await patch(NET_SPACE, { meta: { purpose: 'proposed through REST' }, unknownWriteFields: 'refuse' });
    assert.equal(viaRest.status, 202, `the meta change must wait for its vote: ${viaRest.text}`);
    assert.equal(viaRest.body.status, 'vote_pending');
    assert.equal(stored(NET_SPACE), 'refuse', 'the local setting was dropped by the vote branch (finding DI1)');
    assert.notEqual(spaceOf(NET_SPACE).meta.purpose, 'proposed through REST', 'the meta change was applied without its vote');

    delete spaceOf(NET_SPACE).unknownWriteFields;
    const viaMcp = await mcp('update_space', { space: NET_SPACE, purpose: 'proposed through MCP', unknownWriteFields: 'refuse' });
    assert.equal(viaMcp.refused, false, viaMcp.text);
    assert.match(viaMcp.text, /vote_pending|vote/i, 'update_space no longer says the purpose change waits for a vote');
    assert.equal(stored(NET_SPACE), 'refuse', 'update_space dropped the local setting on a networked space');
    assert.notEqual(spaceOf(NET_SPACE).meta.purpose, 'proposed through MCP');
  });

  it('the setting alone on a networked space is applied (it is never voted) and opens no round', async () => {
    const before = getConfig().networks.find(n => n.id === NET).pendingRounds.map(r => r.roundId).sort();
    const r = await patch(NET_SPACE, { unknownWriteFields: 'refuse' });
    assert.equal(r.status, 200, r.text);
    assert.equal(stored(NET_SPACE), 'refuse');
    assert.deepEqual(getConfig().networks.find(n => n.id === NET).pendingRounds.map(x => x.roundId).sort(), before, 'a local setting opened a round');
  });

  // ── a proxy write is governed by the member ──────────────────────────────────────────────────────────────────────

  it('a write through a proxy is governed by the MEMBER\'s setting, on REST and on MCP, and never by the proxy\'s own', async () => {
    assert.equal(stored(PROXY), 'refuse', 'fixture: the proxy itself holds refuse');
    const entities = `/api/brain/spaces/${PROXY}/entities`;
    const body = { name: 'Acme', type: 'concept', zz: 1 };

    const restRefusing = await rest('POST', `${entities}?targetSpace=${REFUSING}`, body);
    assert.equal(restRefusing.status, 400, `a member set to refuse accepted the write: ${restRefusing.text}`);
    const restWarning = await rest('POST', `${entities}?targetSpace=${WARNING}`, body);
    assert.equal(restWarning.status, 201, `a member that warns was refused because the PROXY holds refuse: ${restWarning.text}`);

    const mcpRefusing = await mcp('save_entity', { space: PROXY, targetSpace: REFUSING, ...body });
    assert.equal(mcpRefusing.refused, true, `a member set to refuse accepted the write over MCP: ${mcpRefusing.text}`);
    const mcpWarning = await mcp('save_entity', { space: PROXY, targetSpace: WARNING, ...body });
    assert.equal(mcpWarning.refused, false, `a member that warns was refused over MCP because the PROXY holds refuse: ${mcpWarning.text}`);

    assert.equal(await door.coll(REFUSING, 'entities').countDocuments({}), 0, 'a refused write landed in the refusing member');
    assert.equal(await door.coll(WARNING, 'entities').countDocuments({}), 2, 'the warning member holds both writes (REST and MCP)');
  });
});
