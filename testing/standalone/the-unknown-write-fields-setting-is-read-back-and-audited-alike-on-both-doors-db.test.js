/**
 * The `unknownWriteFields` setting can be READ BACK on every surface that reports a space's settings, and a change to it is AUDITED as a
 * change of the setting and of nothing else (bundle-128, Q-320; design-v3 section 1.2 "Read path" and section 1.4 "Audit").
 *
 * ## What it prevents
 *
 * - **A setting that cannot be read back.** Without the read path the Settings page shows `Warn` after a reload even when the space
 *   refuses — an operator believes their integrations are tolerated while they are refused. Every surface that reports a space's settings
 *   carries it, as `'refuse'` when set and ABSENT when it warns (the convention the neighbouring settings use): `GET /api/spaces`,
 *   `list_spaces`, `GET /api/spaces/:id/meta` and `space_meta` (both are `spaceMetaAnswer`).
 * - **A meta answer a client cannot send back.** `space_meta`'s answer is spread flat and clients GET it and PATCH it back as a meta; a new
 *   top-level key would be refused by the strict meta body on the next GET-then-PATCH (this is how `invalidRules` was caught, F-46). So the key
 *   joins `SERVER_OWNED_META_FIELDS` and is stripped, not refused, on that door.
 * - **A phantom audit change.** The audit snapshot reads BOTH sides through `unknownWriteFieldsMode`, so absent, `'warn'`, `''` and `null`
 *   are one state and a PATCH that changes nothing records no change of the key (`audit-changes.ts` skips equal sides); a real change records
 *   `warn -> refuse` and `refuse -> warn`, on both doors.
 *
 * ## Red on the unchanged base
 *
 * No projection carries the key, `SERVER_OWNED_META_FIELDS` does not list it, and `AUDIT_CHANGE_FIELDS['space.update']` does not allow it
 * (and `UpdateSpaceBody` does not accept it, so the setting cannot be changed at all).
 *
 * ## One thing this file cannot hold
 *
 * `meta-response-round-trips.test.js` (case "the strip stays SMALL", line 92) asserts `SERVER_OWNED_META_FIELDS.length <= 7`. The list has
 * seven entries today, so adding the key makes that existing case fail; its bound moves to eight in the same change. The file is not one this
 * slice owns (see the return); this file asserts only that the key IS stripped.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-unknown-write-fields-setting-is-read-back-and-audited-alike-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const REFUSING = 'b128-read-refusing';
const WARNING = 'b128-read-warning';

let door, server, base, adminKey, callTool, getConfig, SPACE_AREAS, ADMIN, bodySchemas;

async function rest(method, route, body) {
  const r = await fetch(`${base}${route}`, {
    method, headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
async function mcp(name, args) {
  const out = await callTool({
    name, args,
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
  });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { refused: out.result.isError === true, status: out.status, text, structured: out.result.structuredContent };
}
const spaceOf = (id) => getConfig().spaces.find(s => s.id === id);
const listedOverRest = async (id) => (await rest('GET', '/api/spaces')).body.spaces.find(s => s.id === id);
const listedOverMcp = async (id) => (await mcp('list_spaces', {})).structured.spaces.find(s => s.id === id);
const metaOverRest = async (id) => (await rest('GET', `/api/spaces/${id}/meta`)).body;
const metaOverMcp = async (id) => JSON.parse((await mcp('space_meta', { space: id })).text);
/** `'refuse'`, or `'(absent)'` when the key is not on the object at all — a present-but-falsy key is a different answer. */
const shown = (o) => (Object.hasOwn(o, 'unknownWriteFields') ? o.unknownWriteFields : '(absent)');

const SURFACES = [
  ['GET /api/spaces', listedOverRest], ['list_spaces', listedOverMcp],
  ['GET /api/spaces/:id/meta', metaOverRest], ['space_meta', metaOverMcp],
];

// ONE door for both parts: the loader keeps the `CONFIG_PATH` it was imported with, so a second `openPushDoor` in one process would
// write its config where nothing reads it.
const AUDITED = 'b128-audit-space';

describe('the unknownWriteFields setting is reported and audited as an operator sees it', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'b128-contract-readback',
      spaces: [
        { id: REFUSING, label: REFUSING, folders: [], meta: { suppressEmbeddings: true }, unknownWriteFields: 'refuse' },
        { id: WARNING, label: WARNING, folders: [], meta: { suppressEmbeddings: true } },
        { id: AUDITED, label: AUDITED, folders: [], meta: {} },
      ],
    });
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    bodySchemas = await import('../../server/dist/spaces/body-schemas.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'b128-read-admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await door?.close();
  });
  beforeEach(() => {
    spaceOf(REFUSING).unknownWriteFields = 'refuse';
    delete spaceOf(WARNING).unknownWriteFields;
    delete spaceOf(AUDITED).unknownWriteFields;
  });

  describe('read back', () => {
  for (const [label, read] of SURFACES) {
    it(`${label} carries 'refuse' for a refusing space and the key ABSENT for a warning one`, async () => {
      const refusing = await read(REFUSING);
      assert.equal(shown(refusing), 'refuse', `${label} does not report that ${REFUSING} refuses: ${JSON.stringify(Object.keys(refusing))}`);
      const warning = await read(WARNING);
      assert.equal(shown(warning), '(absent)', `${label} reports a value for a space that warns: ${JSON.stringify(warning.unknownWriteFields)}`);
      // sandwich: the first read still holds, so the second was compared to a stable value
      assert.equal(shown(await read(REFUSING)), 'refuse');
    });
  }

  it('after a clear on each door every surface reads the key absent, not falsy', async () => {
    for (const clear of [() => rest('PATCH', `/api/spaces/${REFUSING}`, { unknownWriteFields: '' }), () => mcp('update_space', { space: REFUSING, unknownWriteFields: null })]) {
      spaceOf(REFUSING).unknownWriteFields = 'refuse';
      for (const [label, read] of SURFACES) assert.equal(shown(await read(REFUSING)), 'refuse', `fixture: ${label} must say refuse before the clear`);
      await clear();
      for (const [label, read] of SURFACES) assert.equal(shown(await read(REFUSING)), '(absent)', `${label} still carries the key after a clear`);
    }
  });

  it('the key is server-owned on the meta door: it is in SERVER_OWNED_META_FIELDS, and a meta read and PATCHed back is not refused for it', async () => {
    assert.ok(bodySchemas.SERVER_OWNED_META_FIELDS.includes('unknownWriteFields'),
      'the meta answer carries the key and the strip list does not name it: the next GET-then-PATCH is a 400 (as invalidRules was)');
    const answer = await metaOverRest(REFUSING);
    assert.equal(shown(answer), 'refuse', 'fixture: the meta answer must carry the key for this case to mean anything');
    const { spaceId: _a, spaceName: _b, stats: _c, ...meta } = answer;
    const back = await rest('PATCH', `/api/spaces/${REFUSING}`, { meta });
    assert.equal(back.status, 200, `the meta answer sent straight back was refused: ${back.text}`);
    assert.equal(spaceOf(REFUSING).unknownWriteFields, 'refuse', 'a meta PATCH changed the instance-local setting (it is stripped on that door, not applied)');
  });
  });

  describe('audited', () => {
  const spaceId = AUDITED;
  const auditRows = () => door.mongo.getDb().collection('audit_log').find({ operation: 'space.update', spaceId }).sort({ timestamp: 1 }).toArray();
  /** The key's own entries in a row's recorded changes. */
  const keyChanges = (row) => (row.changes ?? []).filter(c => c.field === 'unknownWriteFields');

  /** Run one change and return the audit row it left, read once it has landed (an audit write is fire-and-forget). */
  async function audited(act) {
    const before = (await auditRows()).length;
    await act();
    assert.ok(await holdsWithin(async () => (await auditRows()).length > before, 5_000, 20), 'the change left no audit row to read');
    return (await auditRows()).slice(before)[0];
  }

  const DOORS = [
    ['REST', (value) => rest('PATCH', `/api/spaces/${spaceId}`, { unknownWriteFields: value })],
    ['update_space', (value) => mcp('update_space', { space: spaceId, unknownWriteFields: value })],
  ];
  for (const [label, set] of DOORS) {
    it(`${label}: warn -> refuse is recorded as that change, refuse -> warn likewise, and every no-op records none`, async () => {
      const made = await audited(() => set('refuse'));
      assert.deepEqual(keyChanges(made).map(c => ({ from: c.from, to: c.to })), [{ from: 'warn', to: 'refuse' }],
        `the audit row does not record the setting changing: ${JSON.stringify(made.changes)}`);

      const cleared = await audited(() => set(''));
      assert.deepEqual(keyChanges(cleared).map(c => ({ from: c.from, to: c.to })), [{ from: 'refuse', to: 'warn' }],
        `the clear is not recorded as refuse -> warn: ${JSON.stringify(cleared.changes)}`);

      // Absent, 'warn', '' and null are ONE state: a PATCH that sets any of them on a space that warns changes nothing, so it records nothing.
      for (const noop of ['warn', '', null]) {
        const row = await audited(() => set(noop));
        assert.deepEqual(keyChanges(row), [], `a PATCH of ${JSON.stringify(noop)} on a space that already warns recorded a change: ${JSON.stringify(row.changes)}`);
      }
      const again = await audited(() => set('refuse'));
      const twice = await audited(() => set('refuse'));
      assert.equal(keyChanges(again).length, 1);
      assert.deepEqual(keyChanges(twice), [], 'refuse -> refuse recorded a change');
    });
  }
  });
});
