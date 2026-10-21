/**
 * A personal view belongs to one owner, lives and dies with that owner, and is bounded (Q-531, bundle-100, plan rev 3.2).
 *
 * ## The rules (owner rulings e400c526 and 0050bb1e; plan rev 3.1 "Owner", "Lifecycle"; rev 3.2 "Lifecycle and owner", security
 * and integration vets)
 *
 * - **Owner keys** (`viewOwnerOf` in `config/views.ts`): `token:<id>`, `oauth:<clientId>` for an MCP connector token (its id changes
 *   on every rotation), `oidc:<issuer>#<sub>` for an OIDC caller; an OIDC caller with no `sub` has no owner key (no shared
 *   'unknown' principal), so it cannot create a view. The OIDC record is read as `validateOidcJwt` builds it: `{ source: 'oidc', oidcIssuer, oidcSubject }`, its
 *   kind told by `isOidc` (b100 row 8).
 * - **Lifecycle**: a connector rotation keeps the views (same client id); an explicit revoke deletes the owner's views at once; a
 *   cap EVICTION does not (any low-privilege registrar can force one) and leaves them to the sweep; the sweep
 *   (`sweepOwnerlessViews({ now })`) deletes a view only after its owner has had no live token for `VIEW_OWNER_GRACE_MS` (30 days),
 *   and never an OIDC owner's (no stored token to judge by).
 * - **Caps**: 50 views per owner, 1 000 members per view, `'*'` counts as one member.
 * - **Create**: refuses a member the creator cannot read (answered exactly as a missing one, so the refusal is no oracle), a member
 *   that is a view, a name outside `^[a-z0-9-]+$` or longer than 40, and a duplicate name of the same owner (409). A read-only token
 *   may create its own view; a peer-bound token may not.
 * - **Copy** (`POST /api/views/:id/copy`, MCP `view_copy`): only a caller who may manage the receiving token; the copy keeps only the
 *   members the RECEIVER can read; it is idempotent by (receiver, source view); MCP answers the MFA sentence whenever REST would ask
 *   for MFA.
 * - **Reads**: two owners each with `@team` read only their own; a view with no readable member answers `[]` with `viewMembers: []`;
 *   `[@view, member]` reads each member once.
 *
 * ## Seen red
 *
 * At 18e8d598: `POST /api/views` answers 404 `Not found` and MCP `view_create` "Unknown tool", so every door case fails at its first
 * create; `config/views.js` is absent from server/dist (ERR_MODULE_NOT_FOUND) for the owner-key and sweep cases. The assertions after
 * the create pin identities (owner keys, view ids, member lists, which marker a read returned), so a wrong implementation is caught.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-personal-view-belongs-to-its-owner-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf, viewsOf, rowsOf, viewMembersOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const DAY = 86_400_000;
const QA = 'vo-qa';
const OPS = 'vo-ops';
const SECRET = 'vo-secret';
const MISSING = 'vo-nosuch';
const views = () => import('../../server/dist/config/views.js');

let d;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 200)}`;

/** Create a view on REST and insist it worked: the first line every case below goes red on, before the change. */
async function createView(key, name, members) {
  const a = await d.rest(key, 'POST', '/api/views', { name, members });
  assert.equal(a.status, 201, `POST /api/views {name: '${name}'} answered ${fmt(a)}`);
  const v = viewOf(a);
  assert.equal(v?.id, `@${name}`, `the created view's id: ${JSON.stringify(v)}`);
  return v;
}
const storedViews = () => d.loader.getConfig().views ?? [];

describe('a personal view belongs to its owner (Q-531)', { skip }, () => {
  let admin, reader, other, markers;
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-owner', spaces: [QA, OPS, SECRET] });
    admin = await d.mint('vo-admin', {}, { admin: true });
    reader = await d.mint('vo-reader', { [QA]: d.row({ knowledge: 'read', files: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });
    other = await d.mint('vo-other', { [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });
    markers = {};
    for (const s of [QA, OPS, SECRET]) {
      const a = await d.rest(admin.key, 'POST', `/api/brain/spaces/${s}/entities`, { name: `marker-${s}`, type: 'thing' });
      assert.equal(a.status, 201, `seeding ${s}: ${fmt(a)}`);
      markers[s] = a.body._id;
    }
  });
  after(async () => { await d?.close(); });

  describe('owner keys', () => {
    it('token:<id>, oauth:<clientId>, oidc:<issuer>#<sub>; an OIDC caller without sub has no owner', async () => {
      const { viewOwnerOf } = await views();
      assert.equal(viewOwnerOf({ id: 'pat-1', name: 'p' }), 'token:pat-1');
      assert.equal(viewOwnerOf({ id: 'conn-7', name: 'c', oauthClientId: 'client-3' }), 'oauth:client-3');
      assert.equal(viewOwnerOf({ id: 'oidc:abc', name: 'o', source: 'oidc', oidcIssuer: 'https://idp.example', oidcSubject: 'abc' }), 'oidc:https://idp.example#abc');
      let noSub;
      try { noSub = viewOwnerOf({ id: 'oidc:unknown', name: 'o', source: 'oidc', oidcIssuer: 'https://idp.example', oidcSubject: null }); } catch { noSub = null; }
      assert.equal(noSub ?? null, null, `an OIDC caller without a sub got the owner key ${noSub}: every such caller would share one owner`);
    });
  });

  describe('lifecycle', () => {
    it('a connector rotation keeps the views (same client id); the rotated token lists them', async () => {
      const mintConn = (clientId) => d.tokens.createOAuthToken({ clientId, name: clientId, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [QA]: d.row({ knowledge: 'read' }) } }, ttlMs: null, maxTokens: 50 });
      const first = await mintConn('vo-client-rot');
      await createView(first.plaintext, 'rot', [QA]);
      const second = await mintConn('vo-client-rot');
      const list = await d.rest(second.plaintext, 'GET', '/api/views');
      assert.deepEqual(viewsOf(list).map(v => v.id), ['@rot'], `after rotation the connector lists ${fmt(list)}`);
      assert.ok(storedViews().some(v => v.id === '@rot' && v.ownerId === 'oauth:vo-client-rot'), 'the view is not owned by the connector client');
    });

    it('an explicit revoke deletes the owner\'s views at once', async () => {
      const t = await d.mint(uniq('vo-revoked'), { [QA]: d.row({ knowledge: 'read' }) });
      await createView(t.key, 'gone', [QA]);
      assert.ok(storedViews().some(v => v.ownerId === `token:${t.id}`), 'control: the view was stored for its owner');
      assert.equal(await d.tokens.revokeToken(t.id), true);
      assert.deepEqual(storedViews().filter(v => v.ownerId === `token:${t.id}`).map(v => v.id), [], 'the revoked token\'s views remain');
    });

    it('a cap eviction does NOT delete the evicted connector\'s views (they fall to the grace sweep)', async () => {
      d.loader.mutateConfig(cfg => { cfg.tokens = cfg.tokens.filter(t => !t.oauthClientId); });
      const rights = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [QA]: d.row({ knowledge: 'read' }) } };
      const old = await d.tokens.createOAuthToken({ clientId: 'vo-client-old', name: 'old', rights, ttlMs: null, maxTokens: 50 });
      await createView(old.plaintext, 'kept', [QA]);
      await d.tokens.createOAuthToken({ clientId: 'vo-client-new', name: 'new', rights, ttlMs: null, maxTokens: 1 });
      assert.ok(!d.loader.getConfig().tokens.some(t => t.oauthClientId === 'vo-client-old'), 'control: the old connector token was evicted');
      assert.ok(storedViews().some(v => v.id === '@kept' && v.ownerId === 'oauth:vo-client-old'), 'a cap eviction deleted the evicted owner\'s views');
    });

    it('the sweep deletes a view only after its owner had no live token for 30 days, never a live owner\'s or an OIDC owner\'s', async () => {
      const { sweepOwnerlessViews, VIEW_OWNER_GRACE_MS } = await views();
      assert.equal(VIEW_OWNER_GRACE_MS, 30 * DAY);
      const lapsed = await d.mint(uniq('vo-lapsing'), { [QA]: d.row({ knowledge: 'read' }) }, { expiresAt: new Date(Date.now() + DAY).toISOString() });
      const live = await d.mint(uniq('vo-live'), { [QA]: d.row({ knowledge: 'read' }) });
      await createView(lapsed.key, 'lapsed', [QA]);
      await createView(live.key, 'alive', [QA]);
      const now0 = Date.now();
      d.loader.mutateConfig(cfg => {
        cfg.tokens.find(t => t.id === lapsed.id).expiresAt = new Date(now0 - 1000).toISOString();
        cfg.views.push({ id: '@sso', name: 'sso', ownerId: 'oidc:https://idp.example#abc', members: [QA], createdAt: new Date(now0).toISOString() });
      });
      const has = (owner) => storedViews().some(v => v.ownerId === owner);
      await sweepOwnerlessViews({ now: now0 });
      assert.ok(has(`token:${lapsed.id}`), 'deleted on the tick that first saw the owner without a live token');
      await sweepOwnerlessViews({ now: now0 + 29 * DAY });
      assert.ok(has(`token:${lapsed.id}`), 'deleted inside the 30-day grace');
      await sweepOwnerlessViews({ now: now0 + 31 * DAY });
      assert.ok(!has(`token:${lapsed.id}`), 'kept after 30 days without a live token');
      assert.ok(has(`token:${live.id}`), 'a live owner\'s view was swept');
      assert.ok(has('oidc:https://idp.example#abc'), 'an OIDC owner\'s view was swept (it has no stored token to judge by)');
    });
  });

  describe('caps', () => {
    it('50 views per owner: the 51st is refused in words naming the cap', async () => {
      const t = await d.mint(uniq('vo-capper'), { [QA]: d.row({ knowledge: 'read' }) });
      for (let i = 1; i <= 50; i++) await createView(t.key, `cap-${i}`, [QA]);
      const a = await d.rest(t.key, 'POST', '/api/views', { name: 'cap-51', members: [QA] });
      assert.ok(a.status >= 400 && a.status < 500 && /\b50\b/.test(a.error), `the 51st view: ${fmt(a)}`);
      assert.ok(!storedViews().some(v => v.ownerId === `token:${t.id}` && v.id === '@cap-51'), 'the 51st view was stored');
    });

    it('1 000 members per view; \'*\' counts as one', async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `vo-m${i}`);
      d.loader.mutateConfig(cfg => { for (const id of ids) cfg.spaces.push({ id, label: id, folders: [] }); });
      try {
        await createView(admin.key, 'thousand', ids.slice(0, 1000));
        const a = await d.rest(admin.key, 'POST', '/api/views', { name: 'thousand-one', members: ids });
        assert.ok(a.status >= 400 && a.status < 500 && /1[ ,.]?000/.test(a.error), `1 001 members: ${fmt(a)}`);
        const star = await createView(admin.key, 'everything', ['*']);
        assert.deepEqual(star.members, ['*']);
      } finally {
        d.loader.mutateConfig(cfg => { cfg.spaces = cfg.spaces.filter(s => !ids.includes(s.id)); });
      }
    });
  });

  describe('create', () => {
    it('refuses an unreadable member exactly as a missing one, and stores nothing', async () => {
      await createView(reader.key, 'ok-members', [QA, OPS]);
      const secret = await d.rest(reader.key, 'POST', '/api/views', { name: 'leak', members: [QA, SECRET] });
      const missing = await d.rest(reader.key, 'POST', '/api/views', { name: 'leak2', members: [QA, MISSING] });
      assert.ok(secret.status >= 400, `a member the creator cannot read was accepted: ${fmt(secret)}`);
      assert.deepEqual([secret.status, secret.error.split(SECRET).join('<id>')], [missing.status, missing.error.split(MISSING).join('<id>')],
        'an unreadable member is answered unlike a missing one: the refusal tells the caller the space exists');
      assert.ok(!storedViews().some(v => v.id === '@leak'), 'the refused view was stored');
    });

    it('refuses a member that is a view, a bad name, a 41-character name, and a duplicate name (409); accepts 40 characters', async () => {
      await createView(reader.key, 'base-view', [QA]);
      const cases = [
        ['a member that is a view', { name: 'nested', members: ['@base-view'] }, 400],
        ['an upper-case name', { name: 'Bad_Name', members: [QA] }, 400],
        ['a 41-character name', { name: 'a'.repeat(41), members: [QA] }, 400],
        ['a duplicate name', { name: 'base-view', members: [OPS] }, 409],
      ];
      const wrong = [];
      for (const [what, body, status] of cases) {
        const a = await d.rest(reader.key, 'POST', '/api/views', body);
        if (a.status !== status) wrong.push(`${what}: ${fmt(a)} (wanted ${status})`);
      }
      assert.deepEqual(wrong, []);
      await createView(reader.key, 'b'.repeat(40), [QA]);
      assert.deepEqual(storedViews().filter(v => v.ownerId === `token:${reader.id}` && v.id === '@base-view').map(v => v.members), [[QA]], 'the duplicate replaced the original');
    });

    it('a read-only token may create its own view; a peer-bound token may not', async () => {
      const ro = await d.mint(uniq('vo-ro'), { [QA]: d.row({ knowledge: 'read' }, 'read') });
      await createView(ro.key, 'mine-ro', [QA]);
      const peer = await d.mint(uniq('vo-peer'), { [QA]: d.row({ knowledge: 'read' }) }, { peerInstanceId: 'vo-peer-instance' });
      const a = await d.rest(peer.key, 'POST', '/api/views', { name: 'peer-view', members: [QA] });
      assert.equal(a.status, 403, `a peer-bound token creating a view: ${fmt(a)}`);
      assert.ok(!storedViews().some(v => v.ownerId === `token:${peer.id}`), 'a peer-bound token owns a view');
    });
  });

  describe('copy', () => {
    it('a token manager copies a view to a token: only receiver-readable members, idempotent by (receiver, source); a non-manager is refused', async () => {
      const receiver = await d.mint(uniq('vo-receiver'), { [QA]: d.row({ knowledge: 'read' }) });
      await createView(admin.key, 'src', [QA, OPS]);
      const first = await d.rest(admin.key, 'POST', '/api/views/@src/copy', { toTokenId: receiver.id });
      assert.equal(first.status, 201, `copy by an instance admin: ${fmt(first)}`);
      const second = await d.rest(admin.key, 'POST', '/api/views/@src/copy', { toTokenId: receiver.id });
      assert.ok(second.status === 200 || second.status === 201, `a repeated copy: ${fmt(second)}`);
      const theirs = storedViews().filter(v => v.ownerId === `token:${receiver.id}`).map(v => ({ id: v.id, members: v.members }));
      assert.deepEqual(theirs, [{ id: '@src', members: [QA] }], 'the copy kept a member the receiver cannot read, or a retry made a second copy');
      await createView(other.key, 'others', [QA]);
      const refused = await d.rest(other.key, 'POST', '/api/views/@others/copy', { toTokenId: receiver.id });
      assert.equal(refused.status, 403, `a copy by a caller who may not manage the receiver: ${fmt(refused)}`);
      assert.ok(!storedViews().some(v => v.ownerId === `token:${receiver.id}` && v.id === '@others'), 'the refused copy landed');
    });

    it('a copy whose receiver reads none of the members is refused', async () => {
      const blind = await d.mint(uniq('vo-blind'), { [SECRET]: d.row({ knowledge: 'read' }) });
      await createView(admin.key, 'qa-only', [QA]);
      const a = await d.rest(admin.key, 'POST', '/api/views/@qa-only/copy', { toTokenId: blind.id });
      assert.ok(a.status >= 400 && a.status < 500, `a copy with nothing the receiver can read: ${fmt(a)}`);
      assert.ok(!storedViews().some(v => v.ownerId === `token:${blind.id}`), 'an empty copy was stored');
    });

    it('MCP view_copy answers the MFA sentence whenever REST would ask for MFA', async () => {
      const totp = await import('../../server/dist/auth/totp.js');
      const receiver = await d.mint(uniq('vo-mfa-receiver'), { [QA]: d.row({ knowledge: 'read' }) });
      await createView(admin.key, 'mfa-src', [QA]);
      totp.enableMfa('Ythril', 'admin');
      try {
        const rest = await d.rest(admin.key, 'POST', '/api/views/@mfa-src/copy', { toTokenId: receiver.id });
        assert.ok(rest.status === 401 || rest.status === 403, `control: REST asks for MFA (${fmt(rest)})`);
        const m = await d.mcp(admin.key, 'view_copy', { view: '@mfa-src', toTokenId: receiver.id });
        assert.ok(m.isError && /MFA/i.test(m.text) && /web UI/i.test(m.text), `MCP view_copy under MFA answered: ${m.text.slice(0, 200)}`);
        assert.ok(!storedViews().some(v => v.ownerId === `token:${receiver.id}`), 'the MCP copy landed without the second factor');
      } finally { totp.disableMfa(); }
    });
  });

  describe('reads', () => {
    const filter = (key, space) => d.rest(key, 'POST', '/api/filter', { space, collection: 'entities', filter: {} });
    const ids = (a) => rowsOf(a).map(r => r._id).filter(id => Object.values(markers).includes(id)).sort();

    it('two owners each with @team read only their own', async () => {
      const a = await d.mint(uniq('vo-owner-a'), { [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });
      const b = await d.mint(uniq('vo-owner-b'), { [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });
      await createView(a.key, 'team', [QA]);
      await createView(b.key, 'team', [OPS]);
      const ra = await filter(a.key, '@team');
      const rb = await filter(b.key, '@team');
      assert.deepEqual([ids(ra), viewMembersOf(ra)], [[markers[QA]], [QA]], `owner A read ${fmt(ra)}`);
      assert.deepEqual([ids(rb), viewMembersOf(rb)], [[markers[OPS]], [OPS]], `owner B read ${fmt(rb)}`);
    });

    it('a view with no readable member answers [] with viewMembers []', async () => {
      const t = await d.mint(uniq('vo-emptied'), { [QA]: d.row({ knowledge: 'read' }) });
      await createView(t.key, 'emptied', [QA]);
      d.setRights(t.id, r => { r.perSpace[QA] = d.row({}, 'none'); r.perSpace[OPS] = d.row({ knowledge: 'read' }); });
      const a = await filter(t.key, '@emptied');
      assert.equal(a.status, 200, `an empty view: ${fmt(a)}`);
      assert.deepEqual([rowsOf(a), viewMembersOf(a)], [[], []]);
    });

    it('[@view, member] reads each member once', async () => {
      const t = await d.mint(uniq('vo-dedupe'), { [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });
      await createView(t.key, 'both', [QA, OPS]);
      const a = await filter(t.key, ['@both', QA]);
      assert.equal(a.status, 200, fmt(a));
      assert.deepEqual(rowsOf(a).map(r => r._id).filter(id => id === markers[QA]), [markers[QA]], 'a member named twice was read twice');
      assert.deepEqual(ids(a), [markers[QA], markers[OPS]].sort());
    });
  });
});
