/**
 * A space-restricted administrator may edit its OWN spaces' rights and nothing else.
 *
 * ## What was measured before this existed
 *
 * `PATCH /api/tokens/:id` is gated by `requireAdminMfa`, and a space-restricted admin carries `admin: true`, so it was
 * admitted like any other administrator. Probed 2026-08-13 with an admin scoped to one space, against a token scoped to
 * a different one:
 *
 * ```
 * rename that token                       -> 200
 * grant it rights.instanceAdmin: true     -> 200, and STORED
 * grant it rights.createSpaces: true      -> 200, and STORED
 * GET /api/tokens                         -> 200, every token on the instance
 * ```
 *
 * **Both escalated rights were inert**, because the admin routes read the legacy `admin` flag rather than `rights` — so
 * it was a stored escalation, not a live one. That is exactly why it was worth fixing first: the rights matrix exists so
 * guards can move onto `rights`, and the day one does, every token a space admin touched carries what it was handed.
 *
 * ## Why these are red-team tests and not unit tests
 *
 * The owner's Verify line asked for it in those words, and the reason holds: the question is not "does the helper return
 * the right array" but "can a real token, over HTTP, get something it must not". A unit test on
 * `refusalsOutsideEditorScope` would have passed all along on a route that never called it.
 *
 * **Every refusal is paired with the ALLOWED case.** A boundary that refuses everything is not a tier — it is an outage
 * with good intentions, and it would pass a file full of refusals.
 *
 * Run: node --test testing/red-team-tests/space-admin-edit-boundary.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, del, delWithBody } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';
import { spaceAdminRights } from '../_shared/space-admin-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

const MINE = `sa-mine-${RUN}`;      // the space the space-admin holds
const THEIRS = `sa-theirs-${RUN}`;  // a space it does not

let adminToken;                 // unrestricted instance admin
let spaceAdmin;                 // administers MINE and nothing else
let spaceAdminId;
let insideId;                   // a token scoped to MINE
let outsideId;                  // a token scoped to THEIRS
const madeTokens = [];

/**
 * The rights object the API requires: `.strict()` with all four keys, and every AREA MAP must name all four areas.
 *
 * The second half is not obvious and cost a first run: `z.record(z.enum(SPACE_AREAS), z.enum(RUNGS))` requires every
 * area, so `{ knowledge: 'read' }` is a 400 rather than a partial grant — which also means an earlier manual probe of
 * `floor` and `perSpace` had been measuring my own malformed body, not the guard.
 */
const areas = (rung, over = {}) => ({ knowledge: rung, files: rung, schema: rung, dataQuality: rung, ...over });
const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

const mint = async (body) => {
  const r = await post(INSTANCES.a, adminToken, '/api/tokens', body);
  assert.equal(r.status, 201, `token mint failed: ${JSON.stringify(r.body)}`);
  madeTokens.push(r.body.token.id);
  return r.body;
};

before(async () => {
  adminToken = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [MINE, THEIRS]) {
    const r = await post(INSTANCES.a, adminToken, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  }
  const sa = await mint({ name: `sa-admin-${RUN}`, rights: spaceAdminRights([MINE]) });
  spaceAdmin = sa.plaintext;
  spaceAdminId = sa.token.id;
  insideId = (await mint({ name: `sa-inside-${RUN}`, rights: legacyRights({ spaces: [MINE] }) })).token.id;
  outsideId = (await mint({ name: `sa-outside-${RUN}`, rights: legacyRights({ spaces: [THEIRS] }) })).token.id;
});

after(async () => {
  for (const id of madeTokens) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
  for (const id of [MINE, THEIRS]) {
    await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

/** The stored record, read back as the instance admin — the status code is not the assertion. */
async function stored(id) {
  const r = await get(INSTANCES.a, adminToken, '/api/tokens');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.tokens ?? []).find(t => t.id === id);
}

describe('the tier WORKS — a space admin edits its own space', () => {
  it('grants per-space rights for the space it holds', async () => {
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`,
      { rights: rights({ perSpace: { [MINE]: areas('read') } }) });
    assert.equal(r.status, 200, `the allowed edit was refused: ${JSON.stringify(r.body)}`);
    const rec = await stored(insideId);
    assert.equal(rec?.rights?.perSpace?.[MINE]?.knowledge, 'read', 'the grant must actually be stored');
  });

  it('renames a token inside its own scope', async () => {
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`, { name: `renamed-${RUN}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(insideId))?.name, `renamed-${RUN}`);
  });
});

describe('the tier is BOUNDED — each refusal, and nothing written', () => {
  it('cannot grant instanceAdmin', async () => {
    const before = await stored(insideId);
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`,
      { rights: rights({ instanceAdmin: true }) });
    assert.equal(r.status, 403, `instanceAdmin was granted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /instanceAdmin/);
    assert.notEqual((await stored(insideId))?.rights?.instanceAdmin, true, 'nothing may be written by a refused edit');
    assert.equal((await stored(insideId))?.name, before?.name, 'and the rest of the record is untouched');
  });

  it('cannot grant createSpaces', async () => {
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`,
      { rights: rights({ createSpaces: true }) });
    assert.equal(r.status, 403, `createSpaces was granted: ${JSON.stringify(r.body)}`);
    assert.notEqual((await stored(insideId))?.rights?.createSpaces, true);
  });

  it('cannot set a FLOOR — it applies to spaces that do not exist yet', async () => {
    // The non-obvious one. A floor of `read` looks narrower than an admin rung and is broader than any per-space row:
    // it covers every space the instance ever gains.
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`,
      { rights: rights({ floor: areas('read') }) });
    assert.equal(r.status, 403, `a floor was set: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /floor/);
    assert.equal((await stored(insideId))?.rights?.floor ?? null, null);
  });

  it('cannot grant rights for ANOTHER space', async () => {
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${insideId}`,
      { rights: rights({ perSpace: { [THEIRS]: areas('admin') } }) });
    assert.equal(r.status, 403, `a foreign space's row was granted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, new RegExp(THEIRS));
    assert.equal((await stored(insideId))?.rights?.perSpace?.[THEIRS], undefined);
  });

  it('cannot RENAME a token that reaches a space outside its scope', async () => {
    // This is the one that shipped: a bare rename of another space's token answered 200.
    const before = await stored(outsideId);
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${outsideId}`, { name: 'pwned' });
    assert.equal(r.status, 403, `renamed a token outside its scope: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, new RegExp(THEIRS));
    assert.equal((await stored(outsideId))?.name, before?.name, 'the name must be unchanged');
  });

  it('cannot edit an UNRESTRICTED token, which reaches every space', async () => {
    // A token with no allowlist is outside every restricted scope by definition — including the instance admin's own.
    const unrestricted = (await mint({ name: `sa-unrestricted-${RUN}` })).token.id;
    const r = await patch(INSTANCES.a, spaceAdmin, `/api/tokens/${unrestricted}`, { name: 'nope' });
    assert.equal(r.status, 403, `edited an unrestricted token: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /unrestricted/i);
  });
});

describe('listing shows only what the caller could act on', () => {
  it('a space admin does not see tokens from other spaces', async () => {
    const r = await get(INSTANCES.a, spaceAdmin, '/api/tokens');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body.tokens ?? []).map(t => t.id);
    assert.ok(ids.includes(insideId), 'it must still see the tokens it can edit');
    assert.ok(!ids.includes(outsideId),
      'it was shown a token scoped to another space — an inventory of access it cannot touch');
  });

  it('an unrestricted admin still sees everything', async () => {
    // The other half: narrowing the list must not narrow it for the tier that always had it.
    const ids = ((await get(INSTANCES.a, adminToken, '/api/tokens')).body.tokens ?? []).map(t => t.id);
    for (const id of [insideId, outsideId, spaceAdminId]) {
      assert.ok(ids.includes(id), `the instance admin must still see ${id}`);
    }
  });
});
