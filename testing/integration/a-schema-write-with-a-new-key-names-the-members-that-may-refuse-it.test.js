/**
 * A schema write that sets a key an older release refuses answers success AND a `warnings` row naming the members that may
 * refuse it — on REST and MCP, labels only for a token with `networks:read` (`R6-7`, Q-217).
 *
 * ## The gap this states instead of closing
 *
 * From this release a receiver is a tolerant reader: it keeps the meta and type fields it knows and reports the rest. A member on
 * an EARLIER release still refuses a meta with a key it does not know whole (strict body), so a networked space's new
 * `stampSkew` or `rules` would reach it as a refused layer, once per cycle, with the sender never told. Capability negotiation
 * (refuse the write until every member announces it) was withdrawn: it deadlocks on a member that never reports, and a refused
 * write helps nobody who cannot upgrade a peer. So the write goes through, and says what it cannot know:
 *
 *     warnings: [{ code, keys: ['stampSkew'], members: ['<label>', ...] }]
 *
 * `members` are the members of the networks carrying the space whose recorded version is OLDER than this release or UNKNOWN
 * (`peerRunsAtLeast`, which answers false for an absent or unparseable version, and `versionCheckedAt` for what has been
 * exchanged with) — never a member recorded at or above it. A token without `networks:read` on the networks' spaces gets the row
 * and the keys, and NO label: a member's label is the networks area's to read, and a warning must not be the way round it.
 *
 * ## Cases
 *
 *  - REST PATCH setting `stampSkew`, and MCP `schema_update` doing the same: success (200 or 202 vote_pending, which is the
 *    success case on a networked space) and a row naming the old and the unknown member, not the current one;
 *  - the same for `rules` (a new key of the type-schema family), so the row is per NEW KEY and not a `stampSkew` special case;
 *  - a write that sets no new key (the purpose) carries no such row;
 *  - the row without `networks:read`: present, no label anywhere in the answer, on both doors;
 *  - the control: a space whose every member is recorded at a current version answers no member warning for the same write.
 *
 * ## Stack-run
 *
 * Written, NOT run here: it needs the stack's instance A and its container (members' recorded versions are set in A's
 * config.json from outside, then reloaded, as `patchContainerNetwork` does for the other suites). No wait is asynchronous.
 *
 * Run: node --test testing/integration/a-schema-write-with-a-new-key-names-the-members-that-may-refuse-it.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, patch, get, del, delWithBody, patchContainerNetwork } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const MIXED = `skew-mixed-${RUN}`;
const CURRENT = `skew-current-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

const LABEL = { old: `old release member ${RUN}`, unknown: `unknown version member ${RUN}`, current: `current release member ${RUN}`, onlyCurrent: `only current member ${RUN}` };
const ID = {
  old: '55555555-5555-4555-8555-000000000001', unknown: '55555555-5555-4555-8555-000000000002',
  current: '55555555-5555-4555-8555-000000000003', onlyCurrent: '55555555-5555-4555-8555-000000000004',
};

let admin, readsNetworks, noNetworks;
const nets = {};
const sessions = [];

/** A member by the handshake, so the network lists it; its recorded version is set from outside afterwards. */
async function addMember(networkId, key) {
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId });
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', { handshakeId: gen.body.handshakeId, networkId,
    instanceId: ID[key], instanceLabel: LABEL[key], instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const enc = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`)).toString('base64');
  assert.equal((await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA: enc })).status, 200);
}

/** Record, in the container's config, the version this instance last learned for a member; `null` leaves it unrecorded. */
function recordVersion(networkId, instanceId, version) {
  patchContainerNetwork('ythril-a', networkId,
    `const m = n.members.find(x => x.instanceId === '${instanceId}'); if (!m) throw new Error('no member ${instanceId}'); `
    + (version === null ? 'delete m.version; delete m.versionCheckedAt;' : `m.version = '${version}'; m.versionCheckedAt = new Date().toISOString();`));
}

async function mint(name, rights) {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `${name}-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: rights } });
  assert.equal(r.status, 201, `mint ${name}: ${JSON.stringify(r.body)}`);
  return r.body.plaintext;
}

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [MIXED, CURRENT]) assert.equal((await post(INSTANCES.a, admin, '/api/spaces', { id, label: id })).status, 201);
  // Club networks: the inviter admits each member alone. In a closed network the second handshake member waits for the first one's
  // yes, which a member made of a key pair never casts, so it never joined (the Full run's "no member ...0002").
  const mixed = await post(INSTANCES.a, admin, '/api/networks', { label: `skew-mixed-${RUN}`, type: 'club', spaces: [MIXED] });
  assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
  nets.mixed = mixed.body.id;
  const current = await post(INSTANCES.a, admin, '/api/networks', { label: `skew-current-${RUN}`, type: 'club', spaces: [CURRENT] });
  assert.equal(current.status, 201, JSON.stringify(current.body));
  nets.current = current.body.id;
  for (const k of ['old', 'unknown', 'current']) await addMember(nets.mixed, k);
  await addMember(nets.current, 'onlyCurrent');
  recordVersion(nets.mixed, ID.old, '1.0.0');
  recordVersion(nets.mixed, ID.unknown, null);
  recordVersion(nets.mixed, ID.current, '999.0.0');
  recordVersion(nets.current, ID.onlyCurrent, '999.0.0');
  await post(INSTANCES.a, admin, '/api/admin/reload-config', {});
  readsNetworks = await mint('skew-reads', { [MIXED]: { ...FOUR('read'), schema: 'admin', networks: 'read' }, [CURRENT]: { ...FOUR('read'), schema: 'admin', networks: 'read' } });
  noNetworks = await mint('skew-none', { [MIXED]: { ...FOUR('read'), schema: 'admin', networks: 'none' }, [CURRENT]: { ...FOUR('read'), schema: 'admin', networks: 'none' } });
});

after(async () => {
  for (const s of sessions) await s.close?.();
  for (const id of Object.values(nets)) await del(INSTANCES.a, admin, `/api/networks/${id}`).catch(() => {});
  for (const id of [MIXED, CURRENT]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const session = async (tok) => { const s = await openMcpSession(tok); sessions.push(s); return s; };
const callTool = async (s, name, args) => {
  const r = await s.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};
/** The row naming the members that may refuse the keys, wherever the door put it. */
const memberRow = (body, key) => (body.warnings ?? []).find(w => Array.isArray(w.keys) && w.keys.includes(key));
const succeeded = (status) => status === 200 || status === 202;

const KEYS = {
  stampSkew: { rest: { meta: { stampSkew: { warnMinutes: 30 } } }, mcp: { stampSkew: { warnMinutes: 30 } } },
  rules: { rest: { meta: { rules: { keepsItShort: { rule: 'true', message: 'always holds' } } } }, mcp: { rules: { keepsItShort: { rule: 'true', message: 'always holds' } } } },
};

describe('a write setting a new key on a networked space', () => {
  for (const [key, bodies] of Object.entries(KEYS)) {
    it(`REST: ${key} succeeds and the row names the older and the unknown member, not the current one`, async () => {
      const r = await patch(INSTANCES.a, admin, `/api/spaces/${MIXED}`, bodies.rest);
      assert.ok(succeeded(r.status), `the write must not be refused for the members' versions: ${r.status} ${JSON.stringify(r.body)}`);
      const row = memberRow(r.body, key);
      assert.ok(row, `no warnings row names ${key}: ${JSON.stringify(r.body.warnings)}`);
      assert.ok(row.members.includes(LABEL.old), `the member recorded at an older release is not named: ${JSON.stringify(row)}`);
      assert.ok(row.members.includes(LABEL.unknown), `the member with no recorded version is not named (unknown counts as older): ${JSON.stringify(row)}`);
      assert.ok(!row.members.includes(LABEL.current), `a member recorded at a current release is named: ${JSON.stringify(row)}`);
    });

    it(`MCP: ${key} through schema_update says the same`, async () => {
      const s = await session(admin);
      const r = await callTool(s, 'schema_update', { space: MIXED, ...bodies.mcp });
      assert.equal(r.isError, false, `the write was refused: ${r.text}`);
      const row = memberRow(r.body, key);
      assert.ok(row, `no warnings row names ${key}: ${JSON.stringify(r.body)}`);
      assert.deepEqual([...row.members].sort(), [LABEL.old, LABEL.unknown].sort(), 'the members named differ from the older and the unknown one');
      assert.ok(r.text.includes(LABEL.old) || r.text.toLowerCase().includes('older'), `the text an agent reads does not carry the warning: ${r.text}`);
    });
  }

  it('a write that sets no new key carries no such row', async () => {
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${MIXED}`, { meta: { purpose: `no new key ${RUN}` } });
    assert.ok(succeeded(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual((r.body.warnings ?? []).filter(w => Array.isArray(w.members)), [], 'a member warning arrived with a write that sets only keys every release knows');
  });
});

describe('labels only with networks:read', () => {
  it('REST: a token with the networks rung gets the labels; one without gets the row and the key and no label', async () => {
    const withRung = await patch(INSTANCES.a, readsNetworks, `/api/spaces/${MIXED}`, KEYS.stampSkew.rest);
    assert.ok(succeeded(withRung.status), `${withRung.status} ${JSON.stringify(withRung.body)}`);
    assert.ok(memberRow(withRung.body, 'stampSkew')?.members?.includes(LABEL.old), 'the token with networks:read was not told which member');

    const without = await patch(INSTANCES.a, noNetworks, `/api/spaces/${MIXED}`, KEYS.stampSkew.rest);
    assert.ok(succeeded(without.status), `a token without the networks rung is refused the write: ${without.status} ${JSON.stringify(without.body)}`);
    assert.ok(memberRow(without.body, 'stampSkew'), `no warning at all for the token without networks:read: ${JSON.stringify(without.body)}`);
    for (const label of Object.values(LABEL)) assert.ok(!JSON.stringify(without.body).includes(label), `a member's label reached a token without networks:read: ${label}`);
    for (const id of Object.values(ID)) assert.ok(!JSON.stringify(without.body).includes(id), `a member's instance id reached a token without networks:read: ${id}`);
  });

  it('MCP: the same split', async () => {
    const withRung = await callTool(await session(readsNetworks), 'schema_update', { space: MIXED, ...KEYS.stampSkew.mcp });
    assert.equal(withRung.isError, false, withRung.text);
    assert.ok(memberRow(withRung.body, 'stampSkew')?.members?.includes(LABEL.old));

    const without = await callTool(await session(noNetworks), 'schema_update', { space: MIXED, ...KEYS.stampSkew.mcp });
    assert.equal(without.isError, false, without.text);
    assert.ok(memberRow(without.body, 'stampSkew'), `no warning at all for the token without networks:read: ${JSON.stringify(without.body)}`);
    for (const label of Object.values(LABEL)) {
      assert.ok(!JSON.stringify(without.body).includes(label) && !without.text.includes(label), `a member's label reached a token without networks:read: ${label}`);
    }
  });
});

describe('the control: every member recorded at a current release', () => {
  it('the same write answers no member warning, on REST and on MCP', async () => {
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${CURRENT}`, KEYS.stampSkew.rest);
    assert.ok(succeeded(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(memberRow(r.body, 'stampSkew'), undefined, `a warning names members that are all current: ${JSON.stringify(r.body.warnings)}`);
    const m = await callTool(await session(admin), 'schema_update', { space: CURRENT, ...KEYS.stampSkew.mcp });
    assert.equal(m.isError, false, m.text);
    assert.equal(memberRow(m.body, 'stampSkew'), undefined, `a warning names members that are all current: ${JSON.stringify(m.body)}`);
    // The write itself was taken, so the control is not a refused write in disguise: a club's organiser applies a schema change at once,
    // and a network that votes on it holds the round — either is the write having landed.
    const rounds = (await get(INSTANCES.a, admin, `/api/networks/${nets.current}/votes`)).body?.rounds ?? [];
    const meta = (await get(INSTANCES.a, admin, `/api/spaces/${CURRENT}/meta`)).body ?? {};
    assert.ok(rounds.some(x => x.type === 'meta_change') || meta.stampSkew?.warnMinutes === 30,
      `the control write neither landed nor opened a round: it was refused or never reached the network (${JSON.stringify(meta.stampSkew)})`);
  });
});
