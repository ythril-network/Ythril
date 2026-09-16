/**
 * A scoped token cannot read a space it is not scoped to — including its SCHEMA, purpose and usage notes.
 *
 * ## The leak this is written for
 *
 * Three space read routes were mounted behind `requireAuth`, which authenticates and nothing more. Every other
 * space-scoped route uses a guard that calls `enforceSpaceScope`. So a token scoped to one space could read another
 * space's meta, its completeness report and any individual type schema — while the same instance correctly filtered
 * that space out of `GET /api/spaces` for the same token.
 *
 * Found while verifying a 404/403 asymmetry the canary operator reported from a scoping proof run. The asymmetry they
 * described turned out to be a nonexistent endpoint (`GET /api/spaces/:id` does not exist, so the app's catch-all
 * answers `{"error":"Not found"}` for every id). This was underneath it, and their run passed within one request of it.
 *
 * ## Why a red-team test and not an integration test
 *
 * The question is not "does the route work" but "can a token get something it must not". That is this suite's subject,
 * and the assertions are written the way its neighbours are: mint a real token with a real scope, then try.
 *
 * A source gate lives beside it (`standalone/space-routes-honour-token-scope.test.js`) and derives the rule for every
 * space route rather than these three. Two checks because a middleware can be right in source and wrong in mounting
 * order, and because a fourth route added later needs catching on the day it is written.
 *
 * Run: node --test testing/red-team-tests/space-meta-respects-scope.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

const ALLOWED = `scope-ok-${RUN}`;
const FORBIDDEN = `scope-no-${RUN}`;

let adminToken;
let scopedToken;
let scopedTokenId;

/** A GET as the SCOPED token. */
const asScoped = (p) => get(INSTANCES.a, scopedToken, p);

before(async () => {
  adminToken = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

  for (const id of [ALLOWED, FORBIDDEN]) {
    const r = await post(INSTANCES.a, adminToken, '/api/spaces', {
      id, label: id,
      meta: {
        purpose: `CONFIDENTIAL directive for ${id}`,
        usageNotes: `internal notes for ${id}`,
        typeSchemas: { entity: { SecretType: { namingPattern: '^S-' } } },
      },
    });
    assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  }

  const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `scope-probe-${RUN}`, rights: legacyRights({ spaces: [ALLOWED] })});
  assert.equal(t.status, 201, `token mint failed: ${JSON.stringify(t.body)}`);
  scopedToken = t.body.plaintext;
  scopedTokenId = t.body.token.id;
});

after(async () => {
  if (scopedTokenId) await del(INSTANCES.a, adminToken, `/api/tokens/${scopedTokenId}`).catch(() => {});
  for (const id of [ALLOWED, FORBIDDEN]) {
    await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('a scoped token reaches its own space', () => {
  // The other half of every refusal below. Without these, the file would pass just as well against a build that
  // refused everything — and a scoping fix that breaks the allowed path is worse than the leak.
  it('reads the meta of the space it IS scoped to', async () => {
    const r = await asScoped(`/api/spaces/${ALLOWED}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.purpose, `CONFIDENTIAL directive for ${ALLOWED}`);
  });

  it('reads its own completeness report and its own type schema', async () => {
    assert.equal((await asScoped(`/api/spaces/${ALLOWED}/completeness`)).status, 200);
    assert.equal((await asScoped(`/api/spaces/${ALLOWED}/meta/typeSchemas/entity/SecretType`)).status, 200);
  });

  it('sees ONLY that space in the list', async () => {
    const r = await asScoped('/api/spaces');
    const ids = (r.body.spaces ?? []).map(s => s.id);
    assert.deepEqual(ids, [ALLOWED],
      'the list route has always filtered by scope — which is what made the read routes below a defect rather than '
      + `a design choice: got ${JSON.stringify(ids)}`);
  });
});

describe('a scoped token is REFUSED on a space it is not scoped to', () => {
  it('cannot read its meta — purpose, usage notes and typeSchemas are not public', async () => {
    const r = await asScoped(`/api/spaces/${FORBIDDEN}/meta`);
    assert.equal(r.status, 403, `leaked the meta: ${r.status} ${JSON.stringify(r.body)}`);
    // And nothing of the space's content may appear in the refusal itself.
    const body = JSON.stringify(r.body);
    assert.ok(!body.includes('CONFIDENTIAL'), `the refusal echoed the purpose back: ${body}`);
    assert.ok(!body.includes('internal notes'), `the refusal echoed the usage notes back: ${body}`);
  });

  it('cannot read its completeness report', async () => {
    const r = await asScoped(`/api/spaces/${FORBIDDEN}/completeness`);
    assert.equal(r.status, 403, `leaked the completeness report: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it('cannot read an individual type schema', async () => {
    // The narrowest of the three, and the one most likely to be forgotten: it is a nested path under `/meta`, so a
    // fix applied to the two obvious routes would leave this one open.
    const r = await asScoped(`/api/spaces/${FORBIDDEN}/meta/typeSchemas/entity/SecretType`);
    assert.equal(r.status, 403, `leaked an individual schema: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it('still cannot write to it either — the write path was never the problem', async () => {
    const r = await post(INSTANCES.a, scopedToken, `/api/brain/spaces/${FORBIDDEN}/facts`, { fact: 'nope' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});

describe('the reported 404 is a missing ROUTE, not a mask', () => {
  it('GET /api/spaces/:id does not exist, so it 404s for a space the token CAN reach', async () => {
    // the canary operator read `GET /api/spaces/adrs -> 404 {"error":"Not found"}` as the read path masking a
    // permission failure, and concluded reads mask while writes refuse. Asserted here against the space the token IS
    // scoped to: still 404, so the status carries no information about permission at all. The tell is the body — the
    // real routes answer `Space 'x' not found`, this one answers the app's catch-all `Not found`.
    const r = await asScoped(`/api/spaces/${ALLOWED}`);
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, 'Not found',
      'if this route now exists, the asymmetry the partner described becomes real and needs documenting');
  });
});
