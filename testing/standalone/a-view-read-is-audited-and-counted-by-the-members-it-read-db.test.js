/**
 * A read through a personal view is audited and counted by the members it read, a view's own lifecycle is audited without its name or
 * members, and the view metrics move as stated (Q-531, bundle-100, plan rev 3.1 "`@` ids on the doors"; rev 3.2 "Doors and answers",
 * the security vet S7, the observability vets S1/S2/S4 and the integration vet 10).
 *
 * ## The rules
 *
 * 1. **A read through a view is ONE audit row** with `spaceId: null` and `spaces: [<the members read>]` (exactly those: a member the
 *    owner can no longer read is not listed), and its `path` has the view id replaced by `@view`. Nothing in the row names the view.
 *    Same on the REST path route, the tool door and MCP (one row per call each).
 * 2. **View create, update, delete and copy rows** record the owner key and the member COUNT, never the view's name or member ids.
 * 3. **Activity** counts one call per member read, in that member's bucket, and nothing under the view id.
 * 4. **Metrics** (poisoned first, so "written" is told from "plausibly zero"): `ythril_views_total` is the number of stored views;
 *    `ythril_views_deleted_total{reason}` rises by the views deleted, under `owner` for the owner's delete, `revoke` for a revoke and
 *    `sweep` for the grace sweep; `ythril_retired_space_ids` is the number of reserved ids.
 *
 * ## Seen red at 18e8d598
 *
 * `POST /api/views` answers 404, so every row and count case fails at its create; the three metrics are not registered
 * (`getSingleMetric` answers undefined).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-view-read-is-audited-and-counted-by-the-members-it-read-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf } from './_view-doors.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const QA = 'va-qa';
const OPS = 'va-ops';
const DAY = 86_400_000;

let d, admin, register, activity;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 200)}`;
let n = 0;
const uniq = (p) => `${p}-${++n}`;

async function mustCreate(key, name, members) {
  const a = await d.rest(key, 'POST', '/api/views', { name, members });
  assert.equal(a.status, 201, `POST /api/views {name: '${name}'} answered ${fmt(a)}`);
  assert.equal(viewOf(a)?.id, `@${name}`);
}
const both = () => ({ [QA]: d.row({ knowledge: 'read' }), [OPS]: d.row({ knowledge: 'read' }) });

const auditRows = (tokenId, extra = {}) => d.col('audit_log').find({ tokenId, ...extra }).toArray();
/** The rows a token's calls left, once at least `min` have landed (the writer is fire-and-forget). */
const rowsAfter = (tokenId, min = 1, extra = {}) => waitForValue(async () => { const r = await auditRows(tokenId, extra); return r.length >= min ? r : undefined; },
  10_000, 50, undefined, { what: `${min} audit row(s) for ${tokenId}` });

/** Every `key: value` pair anywhere in a document, for "is it recorded somewhere" questions. */
function pairs(doc, out = [], at = '') {
  if (doc && typeof doc === 'object') for (const [k, v] of Object.entries(doc)) { out.push([`${at}${k}`, v]); pairs(v, out, `${at}${k}.`); }
  return out;
}

async function metricValue(name, label = '') {
  const text = await register.getSingleMetricAsString(name);
  const lines = text.split('\n').filter(l => l.startsWith(name) && l.includes(label));
  return lines.reduce((s, l) => s + Number(l.slice(l.lastIndexOf(' ') + 1)), 0);
}
function poison(name) {
  const m = register.getSingleMetric(name);
  assert.ok(m, `${name} is not registered`);
  if (typeof m.set === 'function') m.set(-1);
  return m;
}

describe('a view read is audited and counted by the members it read (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-audit', spaces: [QA, OPS] });
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    activity = await import('../../server/dist/metrics/space-activity.js');
    admin = await d.mint('va-admin', {}, { admin: true });
    d.loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: true }; });
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.col('audit_log').deleteMany({}); activity.drainSpaceActivity(); });

  describe('a read through a view', () => {
    const doors = {
      path: { call: (key, id) => d.rest(key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/stats`), path: /^\/api\/brain\/spaces\/(?:@|%40)view\/stats$/ },
      toolDoor: { call: (key, id) => d.rest(key, 'POST', '/api/filter', { space: id, collection: 'entities', filter: {} }), path: /^\/api\/filter$/ },
      mcp: { call: (key, id) => d.mcp(key, 'filter', { space: id, collection: 'entities', filter: {} }), path: /^http:filter$/ },
    };
    for (const [doorName, door] of Object.entries(doors)) {
      it(`${doorName}: one row, spaceId null, spaces = the members read, the view named nowhere`, async () => {
        const t = await d.mint(uniq('va-reader'), both());
        const name = uniq('va-secretname');
        await mustCreate(t.key, name, [QA, OPS]);
        await d.col('audit_log').deleteMany({});
        const a = await door.call(t.key, `@${name}`);
        assert.ok(a.status < 400 && !a.isError, `the read: ${fmt(a)}`);
        const rows = await rowsAfter(t.id);
        assert.equal(rows.length, 1, `one read left ${rows.length} rows: ${JSON.stringify(rows.map(r => [r.path, r.spaceId]))}`);
        const [row] = rows;
        assert.equal(row.spaceId, null, `spaceId: ${row.spaceId}`);
        assert.deepEqual([...(row.spaces ?? [])].sort(), [OPS, QA], `spaces: ${JSON.stringify(row.spaces)}`);
        assert.match(row.path, door.path);
        assert.ok(!JSON.stringify(row).includes(name), `the row names the view: ${JSON.stringify(row)}`);
      });
    }

    it('a member the owner can no longer read is not in `spaces`', async () => {
      const t = await d.mint(uniq('va-mixed'), both());
      const name = uniq('va-mixedview');
      await mustCreate(t.key, name, [QA, OPS]);
      d.setRights(t.id, r => { r.perSpace[OPS] = d.row({}); });
      await d.col('audit_log').deleteMany({});
      const a = await doors.path.call(t.key, `@${name}`);
      assert.equal(a.status, 200, `the read: ${fmt(a)}`);
      const [row] = await rowsAfter(t.id);
      assert.deepEqual(row.spaces, [QA], `spaces lists a member that was not read: ${JSON.stringify(row.spaces)}`);
    });

    it('activity counts one call per member read and nothing under the view id', async () => {
      const t = await d.mint(uniq('va-activity'), both());
      const name = uniq('va-actview');
      await mustCreate(t.key, name, [QA, OPS]);
      activity.drainSpaceActivity();
      const a = await doors.path.call(t.key, `@${name}`);
      assert.equal(a.status, 200, `the read: ${fmt(a)}`);
      const rows = activity.peekSpaceActivity();
      const bySpace = Object.fromEntries(rows.map(r => [`${r.space}/${r.cls}`, r.totals.n]));
      assert.deepEqual(bySpace, { [`${QA}/read`]: 1, [`${OPS}/read`]: 1 }, `activity after one read through a view of two: ${JSON.stringify(bySpace)}`);
    });
  });

  describe('a view\'s own lifecycle rows', () => {
    it('create, update, copy and delete record the owner key and the member count, never the name or the member ids', async () => {
      const t = await d.mint(uniq('va-life'), both());
      const receiver = await d.mint(uniq('va-recv'), both());
      const name = uniq('va-hiddenname');
      await mustCreate(t.key, name, [QA, OPS]);
      const steps = [
        ['update', t, () => d.rest(t.key, 'PATCH', `/api/views/${encodeURIComponent(`@${name}`)}`, { members: [QA, OPS] })],
        ['copy', admin, () => d.rest(admin.key, 'POST', `/api/views/${encodeURIComponent(`@${name}`)}/copy`, { toTokenId: receiver.id })],
        ['delete', t, () => d.rest(t.key, 'DELETE', `/api/views/${encodeURIComponent(`@${name}`)}`)],
      ];
      for (const [what, , call] of steps) { const a = await call(); assert.ok(a.status < 300, `${what}: ${fmt(a)}`); }
      const ownerRows = await rowsAfter(t.id, 3);
      const [copyRow] = await rowsAfter(admin.id);
      for (const row of [...ownerRows, copyRow]) {
        const text = JSON.stringify(row);
        assert.ok(!text.includes(name), `a view lifecycle row names the view: ${text}`);
        assert.ok(!text.includes(QA) && !text.includes(OPS), `a view lifecycle row names the members: ${text}`);
        const p = pairs(row);
        assert.ok(p.some(([, v]) => v === `token:${t.id}`), `a view lifecycle row does not record the owner key token:${t.id}: ${text}`);
        assert.ok(p.some(([k, v]) => /member/i.test(k) && v === 2), `a view lifecycle row does not record the member count: ${text}`);
      }
    });
  });

  describe('metrics', () => {
    it('ythril_views_total is the number of stored views', async () => {
      poison('ythril_views_total');
      const t = await d.mint(uniq('va-gauge'), both());
      await mustCreate(t.key, uniq('va-g'), [QA]);
      assert.equal(await metricValue('ythril_views_total'), (d.loader.getConfig().views ?? []).length);
    });

    it('ythril_views_deleted_total rises by the views deleted, under owner, revoke and sweep', async () => {
      assert.ok(register.getSingleMetric('ythril_views_deleted_total'), 'ythril_views_deleted_total is not registered');
      const at = (reason) => metricValue('ythril_views_deleted_total', `reason="${reason}"`);
      const t = await d.mint(uniq('va-del'), both());
      const v = uniq('va-own');
      await mustCreate(t.key, v, [QA]);
      const o0 = await at('owner');
      assert.ok((await d.rest(t.key, 'DELETE', `/api/views/${encodeURIComponent(`@${v}`)}`)).status < 300);
      assert.equal(await at('owner') - o0, 1, 'the owner\'s delete was not counted under owner');
      const r = await d.mint(uniq('va-rev'), both());
      await mustCreate(r.key, uniq('va-r1'), [QA]);
      await mustCreate(r.key, uniq('va-r2'), [OPS]);
      const r0 = await at('revoke');
      assert.equal(await d.tokens.revokeToken(r.id), true);
      assert.equal(await at('revoke') - r0, 2, 'a revoke deleting two views was not counted as two under revoke');
      const { sweepOwnerlessViews } = await import('../../server/dist/config/views.js');
      d.loader.mutateConfig(cfg => { cfg.views = [...(cfg.views ?? []), { id: '@va-swept', name: 'va-swept', ownerId: 'token:va-gone-long-ago', members: [QA], createdAt: new Date(0).toISOString() }]; });
      const s0 = await at('sweep');
      await sweepOwnerlessViews({ now: Date.now() + 40 * DAY });
      assert.equal(await at('sweep') - s0, 1, 'the grace sweep was not counted under sweep');
    });

    it('ythril_retired_space_ids is the number of reserved ids', async () => {
      poison('ythril_retired_space_ids');
      d.loader.mutateConfig(cfg => { cfg.retiredSpaceIds = ['va-old-a', 'va-old-b']; });
      assert.equal(await metricValue('ythril_retired_space_ids'), 2);
    });
  });
});
