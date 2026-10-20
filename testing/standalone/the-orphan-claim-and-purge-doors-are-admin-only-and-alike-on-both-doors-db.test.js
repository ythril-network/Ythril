/**
 * The orphan, claim and purge doors are the instance admin's, say no more than they must, and are one capability on both doors
 * (Q-531, bundle-100, plan rev 3.1 "Lifecycle", "Migration"; rev 3.2 "Migration", "Doors and answers", the data-integrity and
 * integration vets; CLAUDE.md "MCP and REST are ONE API with two doors").
 *
 * ## The contract these tests fix (the plan names the doors, not their spelling; this file is where the spelling is chosen)
 *
 * | capability | REST | MCP |
 * |---|---|---|
 * | views whose owner is gone, counted per owner kind | `GET /api/admin/views/orphans` | `view_orphans {}` |
 * | an instance admin takes a copy of an unclaimed (migrated, ownerless) view | `POST /api/admin/views/claim {name}` | `view_claim {name}` |
 * | drop what a retired proxy id still holds and release the id | `POST /api/admin/views/retired/:id/purge {confirmOidcClaims?}` | `view_purge_retired {id, confirmOidcClaims?}` |
 *
 * ## The rules
 *
 * 1. **Admin only.** A token that is not an instance admin (here: admin of every space by its floor) is refused on all
 *    three, on both doors, and nothing changes.
 * 2. **The orphan list counts, it never names.** It answers how many views each owner KIND (`token`, `oauth`) has whose owner holds
 *    no token, and no view name, on either door. A view of a live owner is not counted.
 * 3. **Claim copies an unclaimed view to the caller**, owned by the caller's key, with the members the definition had.
 * 4. **Purge reuses the space-data drop** (`dropSpaceData`): the retired id's collections, its files directory and its activity rows go,
 *    and the id leaves `retiredSpaceIds`. While OIDC maps spaces from a claim it refuses unless `confirmOidcClaims: true`, and the
 *    refusal names that flag (a user whose claim still names the id would reach a space created under it later).
 * 5. **A live space under a retired id drops the reservation**: a config reloaded with an id both in `spaces` and in
 *    `retiredSpaceIds` keeps the space and loses the reservation (the live space wins, integration vet 7).
 *
 * ## Seen red at 18e8d598
 *
 * The three REST doors answer 404 `Not found` and the three tools "Unknown tool"; the reload keeps `retiredSpaceIds` as written (no
 * migration runs). Admin-only cases are red because the admin's own control call (the door works for an admin) fails first.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/the-orphan-claim-and-purge-doors-are-admin-only-and-alike-on-both-doors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewsOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vx-qa';
const OPS = 'vx-ops';
const RETIRED = 'vx-oldteam';
const OIDC = { enabled: true, issuerUrl: 'https://idp.example', clientId: 'vx-client', claimMapping: { spaces: { claim: 'groups' } } };

let d, admin, manager;
const fmt = (a) => `${a.status ?? ''} ${(a.text ?? '').slice(0, 220)}`;
const now = () => new Date().toISOString();

/** The two doors of each capability, answering `{ ok, status?, text, body }` alike. */
const DOORS = {
  rest: {
    orphans: (key) => d.rest(key, 'GET', '/api/admin/views/orphans'),
    claim: (key, name) => d.rest(key, 'POST', '/api/admin/views/claim', { name }),
    purge: (key, id, extra = {}) => d.rest(key, 'POST', `/api/admin/views/retired/${encodeURIComponent(id)}/purge`, extra),
    ok: (a) => a.status >= 200 && a.status < 300,
    payload: (a) => a.body,
  },
  mcp: {
    orphans: (key) => d.mcp(key, 'view_orphans', {}),
    claim: (key, name) => d.mcp(key, 'view_claim', { name }),
    purge: (key, id, extra = {}) => d.mcp(key, 'view_purge_retired', { id, ...extra }),
    ok: (a) => !a.isError,
    payload: (a) => a.structured ?? (() => { try { return JSON.parse(a.text); } catch { return null; } })(),
  },
};

/**
 * The counts an orphan answer carries per owner kind, whichever shape: `{orphans: [{ownerKind, count}]}`, `{orphans: {token: n}}`,
 * or the same at top level.
 */
function countsOf(payload) {
  const o = payload?.orphans ?? payload?.byOwnerKind ?? payload;
  if (Array.isArray(o)) return Object.fromEntries(o.map(r => [r.ownerKind ?? r.kind, r.count ?? r.views]));
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number'));
}

/** A stored view, written as the store holds it. */
const storedView = (name, ownerId, members) => ({ id: `@${name}`, name, ownerId, members, createdAt: now() });

async function seedRetiredRows(id) {
  await d.col(`${id}_entities`).insertOne({ _id: `${id}-row`, spaceId: id, name: 'left behind', type: 'thing' });
  const dir = path.join(process.env['DATA_ROOT'], 'files', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kept.txt'), 'x');
  await d.col('space_activity').insertOne({ _id: `${id}|2026-10-21T00`, space: id, bucket: '2026-10-21T00' }).catch(() => {});
  return dir;
}
const collectionsOf = async (id) => (await d.door.mongo.getDb().listCollections().toArray()).map(c => c.name).filter(n => n.startsWith(`${id}_`));

describe('the orphan, claim and purge doors (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-admin-doors', spaces: [QA, OPS] });
    admin = await d.mint('vx-admin', {}, { admin: true });
    // Everything but instance admin: admin of every space by the floor (the canary operator's token-inventory shape). Still not the
    // instance admin these doors are for.
    manager = await d.tokens.createToken({ name: 'vx-manager', rights: { instanceAdmin: false, createSpaces: true, floor: d.row({}, 'admin'), perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } });
    manager = { key: manager.plaintext, id: manager.record.id };
  });
  after(async () => { await d?.close(); });
  beforeEach(() => d.loader.mutateConfig(cfg => { delete cfg.oidc; }));

  for (const [doorName, door] of Object.entries(DOORS)) {
    describe(`${doorName} door`, () => {
      it('the orphan list counts per owner kind and names no view; a live owner\'s view is not counted', async () => {
        const live = await d.mint(`vx-live-${doorName}`, { [QA]: d.row({ knowledge: 'read' }) });
        const names = [`gone-tok-a-${doorName}`, `gone-tok-b-${doorName}`, `gone-conn-${doorName}`, `alive-${doorName}`];
        d.loader.mutateConfig(cfg => {
          cfg.views = [
            storedView(names[0], `token:vx-revoked-1-${doorName}`, [QA]),
            storedView(names[1], `token:vx-revoked-2-${doorName}`, [QA, OPS]),
            storedView(names[2], `oauth:vx-gone-client-${doorName}`, [OPS]),
            storedView(names[3], `token:${live.id}`, [QA]),
          ];
        });
        const a = await door.orphans(admin.key);
        assert.ok(door.ok(a), `the admin's orphan list: ${fmt(a)}`);
        const counts = countsOf(door.payload(a));
        assert.deepEqual({ token: counts.token, oauth: counts.oauth }, { token: 2, oauth: 1 }, `orphan counts per owner kind: ${fmt(a)}`);
        const leaked = names.filter(n => (a.text ?? '').includes(n));
        assert.deepEqual(leaked, [], 'the orphan list names views');
      });

      it('claim copies an unclaimed view to the calling admin with the definition\'s members', async () => {
        const name = `crew-${doorName}`;
        d.loader.mutateConfig(cfg => { cfg.unclaimedViews = [{ name, members: [QA, OPS], migratedFrom: name, createdAt: now() }]; });
        const a = await door.claim(admin.key, name);
        assert.ok(door.ok(a), `claim: ${fmt(a)}`);
        const mine = viewsOf(await d.rest(admin.key, 'GET', '/api/views')).find(v => v.id === `@${name}`);
        assert.ok(mine, 'the claimed view is not among the admin\'s views');
        assert.deepEqual([...mine.members].sort(), [OPS, QA]);
        const stored = (d.loader.getConfig().views ?? []).find(v => v.id === `@${name}` && v.ownerId === `token:${admin.id}`);
        assert.ok(stored, `the claimed view is not owned by token:${admin.id}`);
      });

      it('purge drops the retired id\'s collections, files and activity through the space-data drop and releases the id', async () => {
        const id = `${RETIRED}-${doorName}`;
        d.loader.mutateConfig(cfg => { cfg.retiredSpaceIds = [id]; });
        const dir = await seedRetiredRows(id);
        assert.ok((await collectionsOf(id)).length > 0, 'control: the retired id holds a collection');
        const a = await door.purge(admin.key, id);
        assert.ok(door.ok(a), `purge: ${fmt(a)}`);
        assert.deepEqual(await collectionsOf(id), [], 'the retired id still has collections');
        assert.ok(!fs.existsSync(dir), 'the retired id\'s files directory is still there');
        assert.equal(await d.col('space_activity').countDocuments({ space: id }), 0, 'the retired id\'s activity rows are still there');
        assert.ok(!(d.loader.getConfig().retiredSpaceIds ?? []).includes(id), 'the purged id is still reserved');
      });

      it('purge refuses while OIDC maps spaces from a claim, unless confirmOidcClaims is sent', async () => {
        const id = `${RETIRED}-oidc-${doorName}`;
        d.loader.mutateConfig(cfg => { cfg.retiredSpaceIds = [id]; cfg.oidc = structuredClone(OIDC); });
        await seedRetiredRows(id);
        const refused = await door.purge(admin.key, id);
        assert.ok(!door.ok(refused), `purge with OIDC claim mapping and no confirmation was carried out: ${fmt(refused)}`);
        assert.match(refused.text, /confirmOidcClaims/, 'the refusal does not name the flag that confirms it');
        assert.ok((await collectionsOf(id)).length > 0 && d.loader.getConfig().retiredSpaceIds.includes(id), 'the refused purge changed something');
        const done = await door.purge(admin.key, id, { confirmOidcClaims: true });
        assert.ok(door.ok(done), `purge with confirmOidcClaims: ${fmt(done)}`);
        assert.deepEqual(await collectionsOf(id), []);
      });

      it('every one of the three refuses a token that is not an instance admin, and changes nothing', async () => {
        const id = `${RETIRED}-deny-${doorName}`;
        const name = `deny-${doorName}`;
        d.loader.mutateConfig(cfg => {
          cfg.retiredSpaceIds = [id];
          cfg.unclaimedViews = [{ name, members: [QA], migratedFrom: name, createdAt: now() }];
          cfg.views = [storedView(`gone-${doorName}`, 'token:vx-nobody', [QA])];
        });
        await seedRetiredRows(id);
        const control = await door.orphans(admin.key);
        assert.ok(door.ok(control), `control: the admin's orphan list: ${fmt(control)}`);
        const answers = { orphans: await door.orphans(manager.key), claim: await door.claim(manager.key, name), purge: await door.purge(manager.key, id, { confirmOidcClaims: true }) };
        const served = Object.entries(answers).filter(([, a]) => door.ok(a)).map(([k, a]) => `${k}: ${fmt(a)}`);
        assert.deepEqual(served, [], 'a non-admin was served');
        if (doorName === 'rest') for (const [k, a] of Object.entries(answers)) assert.equal(a.status, 403, `${k}: ${fmt(a)}`);
        assert.ok((await collectionsOf(id)).length > 0 && d.loader.getConfig().retiredSpaceIds.includes(id), 'a refused purge dropped data or released the id');
        assert.ok(!(d.loader.getConfig().views ?? []).some(v => v.ownerId === `token:${manager.id}`), 'a refused claim gave the caller a view');
      });
    });
  }

  it('a config reloaded with a retired id that is a live space keeps the space and drops the reservation', async () => {
    await d.loader.flushConfig();
    const file = process.env['CONFIG_PATH'];
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.retiredSpaceIds = [QA, `${RETIRED}-still`];
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
    const r = await d.rest(admin.key, 'POST', '/api/admin/reload-config');
    assert.equal(r.status, 200, `reload: ${fmt(r)}`);
    const cfg = d.loader.getConfig();
    assert.ok(cfg.spaces.some(s => s.id === QA), 'the live space was dropped');
    assert.deepEqual(cfg.retiredSpaceIds, [`${RETIRED}-still`], 'the reservation of a live space id was kept (or an unrelated one lost)');
  });
});
