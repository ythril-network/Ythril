/**
 * No door that serves a network, or answers a joiner, hands out a per-space mark, a frozen 5.x mark or the 6.0 sync stamp
 * (bundle-81 test 19; design rev 8 section 3b, decision 17; the parent's decisions 39 and 42).
 *
 * ## The leak this holds
 *
 * `networkView` removes the two re-read cursors by name and spreads every other member key, and `safeMemberList` removes only
 * `tokenHash` and `skipTlsVerify`. So every mark a member carries (`lastSeqReceived`, `lastSeqPushed`, `lastSeqServed`, the file
 * tombstone acknowledgement, and in 6.0 `lastPosReceived`, `lastPosPushed`, `lastPosServed`, `lastSyncAtBy6`) goes to any caller who
 * may read a network and to every joiner. Rev 8 closes that: a view is built from an allow list per audience (`memberView`), so a
 * key nobody listed is not shown.
 *
 * ## The rule, over the whole set it governs
 *
 * The marks are DERIVED, not listed: `PER_SPACE_WATERMARKS` and (once it exists) `ROLLBACK_MARKS` from `config/types-networks.ts`,
 * plus the 6.0 names the plan adds to them. A floor says the set is not empty. Every member the doors answer is walked, at every
 * depth, and no key of the set may appear and no sentinel value a mark held may be in the body. A positive control in the same case
 * says the body is still a network view (identity, status, the role), so an empty answer cannot pass.
 *
 * Doors driven: `GET /api/networks`, `GET /api/networks/:id`, MCP `network_get` (through the shared act), and the join answer
 * (`admitByInviteKeyAct`, which both the REST join route and the MCP join tool answer through).
 *
 * ## Decisions 39 and 42 (the admin view)
 *
 * The admin view (`networkAnswer`, which adds `owedSpaceActs` for an instance administrator) carries the re-read owed marker as its
 * OWN field, and per-space record counts for the network's spaces. The plan names neither key: the test looks for a top-level key that
 * says `reread` and one that says `record` and `count`, and the report names the keys it expects to be settled.
 *
 * Run: node --test testing/standalone/the-network-views-show-no-marks-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { M1, tempInstance, networkOf, boot, route, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-b81d-views-');
const skip = await mongoSkipReason();
const NET = '11111111-1111-4111-8111-111111111111';
const SENTINEL = 7_777_771;
const SYNC_STAMP = '2026-10-20T12:34:56.000Z';
/** The 6.0 names the plan adds. Written out because the module that will own them does not exist at the base; `types-networks` is read first. */
const SIX_ZERO_MARKS = ['lastPosReceived', 'lastPosPushed', 'lastPosServed'];
const FROZEN_FIVE_X = ['lastSeqReceived', 'lastSeqPushed', 'lastSeqServed'];

/** Every key at every depth, with its path. */
function keysDeep(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysDeep(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push({ key: k, path: `${path}.${k}` }); keysDeep(v, `${path}.${k}`, out); }
  return out;
}

describe('the network views show no marks', { skip }, () => {
  let mongo; let callTool; let adminRights; let readerRights; let MARKS; let crud;
  const memberMarks = () => ({
    ...Object.fromEntries(MARKS.map(m => [m, { general: SENTINEL, notes: SENTINEL }])),
    lastSyncAtBy6: SYNC_STAMP,
  });

  before(async () => {
    mongo = await openTestMongo('b81tD_views');
    await databaseTakesCollections(mongo);
    const types = await import('../../server/dist/config/types-networks.js');
    // Derived: every per-space watermark the module classifies, the frozen class when it exists, and the 6.0 names.
    MARKS = [...new Set([...types.PER_SPACE_WATERMARKS, ...(types.ROLLBACK_MARKS ?? []), ...FROZEN_FIVE_X, ...SIX_ZERO_MARKS])];
    assert.ok(MARKS.length >= 8, `only ${MARKS.length} mark kinds derived — the set this test governs is empty or broken`);
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ crudRouter: crud } = await import('../../server/dist/api/networks/crud.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const floorOf = (rung) => Object.fromEntries(SPACE_AREAS.map(a => [a, rung]));
    adminRights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: floorOf('admin') };
    readerRights = { instanceAdmin: false, createSpaces: false, perSpace: {}, floor: floorOf('read'), spaceAdmin: { floor: false, spaces: [] } };
    await boot(dir, {
      spaces: ['notes'],
      networks: [networkOf('closed', [M1], { id: NET, spaces: ['general', 'notes'], memberExtra: memberMarks() })],
    });
  });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  let serial = 0;
  const tool = async (name, args, rights) => {
    const id = `b81d-${++serial}`;
    const out = await callTool({ name, args, caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: id, tokenLabel: id } });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('');
    return out.result.structuredContent ?? (() => { try { return JSON.parse(text); } catch { assert.fail(`${name} answered ${out.status}: ${text.slice(0, 200)}`); } })();
  };
  const networkOf0 = (body) => (body.networks ? body.networks.find(n => n.id === NET) : body);

  /** The rule, for one answer: no mark key at any depth, no sentinel value, and still a view of the network. */
  function assertNoMarks(what, body, members) {
    const keys = keysDeep(body);
    assert.ok(keys.length > 10, `${what}: the body is empty (${keys.length} keys) — the door answered nothing to check`);
    const leaked = keys.filter(k => MARKS.includes(k.key) || k.key === 'lastSyncAtBy6').map(k => k.path);
    assert.deepEqual(leaked, [], `${what} hands out per-space marks or the 6.0 sync stamp: ${leaked.join(', ')}`);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(String(SENTINEL)), `${what}: a value a mark held (${SENTINEL}) is in the body`);
    assert.ok(!text.includes(SYNC_STAMP), `${what}: the 6.0 sync stamp ${SYNC_STAMP} is in the body`);
    assert.ok(members.length >= 1 && members.some(m => m.instanceId === M1), `${what}: the member is gone from the view — a view that shows nothing cannot pass`);
  }

  it('the control: the stored member does carry every mark, so a view that shows none has withheld them', async () => {
    const { getConfig } = await import('../../server/dist/config/loader.js');
    const stored = getConfig().networks.find(n => n.id === NET).members[0];
    for (const m of MARKS) assert.deepEqual(stored[m], { general: SENTINEL, notes: SENTINEL }, `the fixture does not hold ${m}`);
  });

  it('GET /api/networks and GET /api/networks/:id, for an administrator and for a reader', async () => {
    for (const [who, rights] of [['admin', adminRights], ['reader', readerRights]]) {
      const list = (await route(crud, 'get', '/', { authToken: { rights } })).body;
      const one = (await route(crud, 'get', '/:id', { params: { id: NET }, authToken: { rights } })).body;
      assertNoMarks(`GET /api/networks as ${who}`, list, networkOf0(list).members);
      assertNoMarks(`GET /api/networks/:id as ${who}`, one, one.members);
    }
  });

  it('MCP network_get, for an administrator and for a reader', async () => {
    for (const [who, rights] of [['admin', adminRights], ['reader', readerRights]]) {
      const body = await tool('network_get', { id: NET }, rights);
      assertNoMarks(`network_get as ${who}`, body, body.members);
    }
  });

  it('the join answer a joiner receives', async () => {
    const bcrypt = createRequire(new URL('../../server/package.json', import.meta.url))('bcrypt');
    const { admitByInviteKeyAct } = await import('../../server/dist/networks/member-acts.js');
    const { getConfig, saveConfig } = await import('../../server/dist/config/loader.js');
    const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
    const KEY = 'a-join-key-that-is-long-enough-to-pass-the-schema-check-0123456789';
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === NET);
    net.pendingRounds = [{
      roundId: 'r-join', type: 'join', subjectInstanceId: JOINER, subjectLabel: 'Joiner', subjectUrl: '', openedAt: '2026-10-09T10:00:00.000Z',
      deadline: '2026-10-10T10:00:00.000Z', votes: [], concluded: true, passed: true, inviteKeyHash: await bcrypt.hash(KEY, 4),
      pendingMember: { instanceId: JOINER, label: 'Joiner', url: 'https://b1.example.com', tokenHash: 'h', direction: 'both' },
    }];
    saveConfig(cfg);
    const out = await admitByInviteKeyAct(NET, { instanceId: JOINER, inviteKey: KEY, label: 'Joiner', url: 'https://b1.example.com', token: 'a-plaintext-peer-token' });
    assert.equal(out.status, 200, `the join was not admitted, so there is no answer to check: ${JSON.stringify(out).slice(0, 300)}`);
    assertNoMarks('the join answer', out.body, out.body.members);
  });

  describe('the admin view (decisions 39 and 42)', () => {
    const topKeys = (body) => Object.keys(body);

    it('decision 39: once a re-read is owed, the admin view carries the owed marker as its own field, and a reader sees none', async () => {
      const started = await route(crud, 'post', '/:id/reread', { params: { id: NET }, body: { confirm: true }, authToken: { rights: adminRights } });
      assert.equal(started.code, 200, `POST /api/networks/:id/reread is not a route that answers: ${JSON.stringify(started.body)}`);
      const admin = (await route(crud, 'get', '/:id', { params: { id: NET }, authToken: { rights: adminRights } })).body;
      const reader = (await route(crud, 'get', '/:id', { params: { id: NET }, authToken: { rights: readerRights } })).body;
      const mcp = await tool('network_get', { id: NET }, adminRights);
      for (const [door, body] of [['REST', admin], ['MCP', mcp]]) {
        assert.ok(topKeys(body).some(k => /reread/i.test(k)), `${door}: the admin view has no re-read owed field beside owedSpaceActs (keys: ${topKeys(body).join(', ')})`);
        assertNoMarks(`${door} admin view after a re-read was started`, body, body.members);
      }
      assert.ok(!topKeys(reader).some(k => /reread/i.test(k)), 'a reader sees the re-read owed marker — an administrator\'s debt, as owedSpaceActs is');
      assert.deepEqual(topKeys(admin).filter(k => /reread/i.test(k)), topKeys(mcp).filter(k => /reread/i.test(k)), 'the two doors name the owed marker differently');
    });

    it('decision 42: the admin view carries the record count of each of the network\'s spaces, the same on both doors', async () => {
      const counts = { general: 3, notes: 5 };
      for (const [space, n] of Object.entries(counts)) {
        await mongo.col(`${space}_facts`).deleteMany({});
        await mongo.col(`${space}_facts`).insertMany(Array.from({ length: n }, (_, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `f${i}`, seq: i + 1, createdAt: SYNC_STAMP })));
      }
      const admin = (await route(crud, 'get', '/:id', { params: { id: NET }, authToken: { rights: adminRights } })).body;
      const mcp = await tool('network_get', { id: NET }, adminRights);
      for (const [door, body] of [['REST', admin], ['MCP', mcp]]) {
        const key = topKeys(body).find(k => /record/i.test(k) && /count/i.test(k));
        assert.ok(key, `${door}: the admin view carries no per-space record count (keys: ${topKeys(body).join(', ')})`);
        // A count is what the space holds: facts only here, so any other family a space holds would add to it. The sentinel is the facts seeded above.
        for (const [space, n] of Object.entries(counts)) {
          assert.equal(body[key][space], n, `${door}: ${key}.${space} is ${body[key][space]}, the space holds ${n} records`);
        }
      }
    });
  });
});
