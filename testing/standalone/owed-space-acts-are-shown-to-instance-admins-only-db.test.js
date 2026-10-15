/**
 * An owed deletion, wipe or rename has a real surface, and it is for INSTANCE ADMINISTRATORS only — on both doors (bundle-106 R-W17, R-X14; design v5
 * section 2.6, X14, X18).
 *
 * ## The defect this holds
 *
 * A passed vote whose act failed is a standing debt: it keeps the space closed to writes and held out of the exchange until a retry completes, and until
 * now nothing but the log said so. The answer must be somewhere an operator reads (`GET /api/networks/:id`, MCP `network_get`, and the space's own entry
 * on `GET /api/spaces` and `list_spaces`) — and it must NOT be readable by a token that may only read the network: `networkView` answers
 * `networks: read` and its docblock withholds `pendingRounds` for exactly this reason. An owed list in the view would hand every reader the
 * proposer's failures. So one function both doors call, `networkAnswer(net, token)`, adds `owedSpaceActs` when the token is an instance administrator; and
 * one reader, `spaceActPendingField(cfg, spaceId, token)`, adds `actPending` to a space's entry (there is no `GET /api/spaces/:id`; REST lists through
 * `GET /api/spaces` and MCP `list_spaces` builds its own entry) — the same asymmetry on both.
 *
 * ## What each row asserts
 *
 * An entry stands owed for `notes` (a failed wipe: attempts 2, a retry in the future, one round of a club network); an instance administrator and a token
 * holding `networks: read` each read the network and the space list through REST and through the tool. The administrator sees `owedSpaceActs` with the
 * entry's id, kind, space, rounds, attempts, next retry, since and state, and `actPending` on the space; the other token sees NEITHER (an absent field,
 * never an empty list: "none owed" would be a statement it may not make). An act with no round (an unnetworked wipe) shows on the space entry only.
 *
 * Run: node --test testing/standalone/owed-space-acts-are-shown-to-instance-admins-only-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { seedActEntry, passedSpaceRound } from './_space-act-harness.mjs';
import { M1, tempInstance, networkOf, boot, route, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-owed-view-');
const skip = await mongoSkipReason();
const NET = '11111111-1111-4111-8111-111111111111'; // a network id is a v4 uuid on the tool door
const RETRY = new Date(Date.now() + 3_600_000).toISOString();
const SINCE = '2026-10-16T00:00:00.000Z';

describe('owed acts are shown to instance administrators only, on both doors', { skip }, () => {
  let mongo; let callTool; let reader; let adminRights;
  before(async () => {
    process.env['YTHRIL_MODELS_OFFLINE'] = '1';
    mongo = await openTestMongo('owed_view');
    await databaseTakesCollections(mongo);
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const floorOf = (rung) => Object.fromEntries(SPACE_AREAS.map(a => [a, rung]));
    adminRights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: floorOf('admin') };
    // A token that may read every area of every space and administers nothing: it sees the networks, not the instance's debts.
    reader = { instanceAdmin: false, createSpaces: false, perSpace: {}, floor: floorOf('read'), spaceAdmin: { floor: false, spaces: [] } };
  });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  let serial = 0;
  const tool = async (name, args, rights) => {
    const id = `owed-${++serial}`;
    const out = await callTool({ name, args, caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: id, tokenLabel: id } });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('');
    return out.result.structuredContent ?? (() => { try { return JSON.parse(text); } catch { assert.fail(`${name} answered ${out.status}: ${text.slice(0, 200)}`); } })();
  };
  const listed = (body, id) => (Array.isArray(body) ? body : body.spaces ?? []).find(s => s.id === id);

  /** `notes` carried by a club, a failed wipe of it owed: its entry names the round; plus `solo`, an unnetworked space with a failed wipe of its own. */
  async function owed() {
    const round = passedSpaceRound('w-owed', 'space_wipe', 'notes', { networkSpaceId: 'notes' });
    const loader = await boot(dir, { spaces: ['notes', 'solo'], networks: [networkOf('club', [M1], { id: NET, spaces: ['general', 'notes'], extra: { pendingRounds: [round] } })] });
    const entry = await seedActEntry(loader, { kind: 'wipe', localId: 'notes', rounds: [{ networkId: NET, roundId: 'w-owed' }], state: 'owed', attempts: 2, retryAt: RETRY, registeredAt: SINCE });
    const soloEntry = await seedActEntry(loader, { kind: 'wipe', localId: 'solo', rounds: [], state: 'owed', attempts: 1, retryAt: RETRY, registeredAt: SINCE });
    return { entry, soloEntry };
  }

  it('R-X14: an instance administrator reads owedSpaceActs on GET /api/networks/:id and on network_get, with the entry\'s facts', async () => {
    const { entry } = await owed();
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    const rest = (await route(crudRouter, 'get', '/:id', { params: { id: NET }, authToken: { rights: adminRights } })).body;
    const mcp = await tool('network_get', { id: NET }, adminRights);
    for (const [door, body] of [['REST', rest], ['MCP', mcp]]) {
      assert.ok(Array.isArray(body.owedSpaceActs), `${door}: no owedSpaceActs for an instance administrator: ${Object.keys(body).join(', ')}`);
      const row = body.owedSpaceActs.find(r => r.entryId === entry.id);
      assert.ok(row, `${door}: the owed wipe is not listed`);
      assert.deepEqual({ kind: row.kind, localSpaceId: row.localSpaceId, attempts: row.attempts, state: row.state, since: row.since, nextRetryAt: row.nextRetryAt },
        { kind: 'wipe', localSpaceId: 'notes', attempts: 2, state: 'owed', since: SINCE, nextRetryAt: RETRY });
      assert.deepEqual(row.rounds.map(r => r.roundId), ['w-owed']);
    }
    assert.deepEqual(Object.keys(rest.owedSpaceActs[0]).sort(), Object.keys(mcp.owedSpaceActs[0]).sort(), 'the two doors answer different shapes');
  });

  it('R-X14: a token that may only read the network sees no owedSpaceActs — an absent field, not an empty list — on either door', async () => {
    await owed();
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    const rest = (await route(crudRouter, 'get', '/:id', { params: { id: NET }, authToken: { rights: reader } })).body;
    const mcp = await tool('network_get', { id: NET }, reader);
    for (const [door, body] of [['REST', rest], ['MCP', mcp]]) {
      assert.equal(body.id, NET, `${door}: the reader could not read the network at all: ${JSON.stringify(body).slice(0, 160)}`);
      assert.equal('owedSpaceActs' in body, false, `${door}: owedSpaceActs reached a token that is not an instance administrator`);
    }
  });

  it('R-W17: the space\'s own entry carries actPending for an administrator — also for an act with no round — and never for another token', async () => {
    const { entry, soloEntry } = await owed();
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const asAdmin = { rest: (await route(spacesRouter, 'get', '/', { authToken: { rights: adminRights } })).body, mcp: await tool('list_spaces', {}, adminRights) };
    const asReader = { rest: (await route(spacesRouter, 'get', '/', { authToken: { rights: reader } })).body, mcp: await tool('list_spaces', {}, reader) };
    for (const [door, body] of Object.entries(asAdmin)) {
      const notes = listed(body, 'notes');
      const solo = listed(body, 'solo');
      assert.ok(notes?.actPending, `${door}: no actPending on a space with an owed act (it was wipePending in v4, and not on this door at all)`);
      assert.deepEqual({ kind: notes.actPending.kind, attempts: notes.actPending.attempts, state: notes.actPending.state, since: notes.actPending.since, nextRetryAt: notes.actPending.nextRetryAt },
        { kind: 'wipe', attempts: 2, state: 'owed', since: SINCE, nextRetryAt: RETRY });
      assert.equal(solo?.actPending?.attempts, 1, `${door}: an act with no round (unnetworked) shows on the space entry`);
    }
    for (const [door, body] of Object.entries(asReader)) {
      for (const id of ['notes', 'solo']) {
        const s = listed(body, id);
        if (s) assert.equal('actPending' in s, false, `${door}: actPending reached a token that is not an instance administrator`);
      }
    }
    void entry; void soloEntry;
  });

  it('the pointer every refusal gives is real: GET /api/networks/:id answers the owed list the rename refusal and the queued text name', async () => {
    const { entry } = await owed();
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    const body = (await route(crudRouter, 'get', '/:id', { params: { id: NET }, authToken: { rights: adminRights } })).body;
    assert.ok(body.owedSpaceActs?.some(r => r.entryId === entry.id), 'the failure sentence points at owedSpaceActs, which the network answer does not carry');
  });
});
